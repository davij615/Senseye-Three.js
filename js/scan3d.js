/* Senseye — WebGL ocular scan engine (Three.js).
   Video plays as a texture inside the scene, the navy grade is a shader,
   the scan overlay is GPU geometry with post-processed bloom, and the
   camera adds dolly + parallax. Crisp text stays in the DOM (#glLabels). */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }     from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass }from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass }     from "three/addons/postprocessing/OutputPass.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const frameEl = document.querySelector(".frame");
const canvas  = document.getElementById("scanCanvas");
const video   = document.getElementById("bgvid");
const btn     = document.getElementById("scanBtn");
const hud     = document.getElementById("hud");
const phaseEl = document.getElementById("hudPhase");
const subEl   = document.getElementById("hudSub");
const pctEl   = document.getElementById("hudPct");
const barEl   = document.getElementById("hudBar");
const flashEl = document.getElementById("flash");
const pupilEl = document.getElementById("mPupil");
const metricEls = [...document.querySelectorAll(".hud-metrics .m")];
const lockEl  = document.getElementById("glLock");
const anomEls = [0,1,2].map(i=>document.getElementById("glAnom"+i));
const doneEl  = document.getElementById("glComplete");

frameEl.classList.add("webgl");

/* ---------------- eye tracking (same data + mapping as the 2D engine) --- */
const VID_W=1920, VID_H=1080;
const EYE_X=0.4706, EYE_Y=0.4935, IRIS_R=0.1815;
const sm = {cx:null, cy:null, r:null, pr:null};
let W=0, H=0;

function eyeState(){
  const s = Math.max(W/VID_W, H/VID_H);
  const ox=(W-VID_W*s)/2, oy=(H-VID_H*s)/2;
  let cxv=EYE_X*VID_W, cyv=EYE_Y*VID_H, irv=IRIS_R*VID_H, prv=irv*0.33;
  const T=window.EYE_TRACK;
  if(T && video.readyState>=2 && !isNaN(video.currentTime)){
    const n=T.n, total=2*n-1;
    let g=video.currentTime*T.fps;
    g=((g%total)+total)%total;
    let f=g<=n-1 ? g : 2*n-2-g;
    f=Math.max(0,Math.min(n-1.001,f));
    const i=Math.floor(f),k=f-i,j=Math.min(i+1,n-1);
    const L=a=>a[i]*(1-k)+a[j]*k;
    cxv=L(T.cx);cyv=L(T.cy);irv=L(T.ir);prv=L(T.pr);
  }
  const a=0.35;
  sm.cx=sm.cx===null?cxv:sm.cx+(cxv-sm.cx)*a;
  sm.cy=sm.cy===null?cyv:sm.cy+(cyv-sm.cy)*a;
  sm.r =sm.r ===null?irv:sm.r +(irv-sm.r )*a;
  sm.pr=sm.pr===null?prv:sm.pr+(prv-sm.pr)*a;
  return {cx:ox+sm.cx*s, cy:oy+sm.cy*s, r:sm.r*s, pr:sm.pr*s,
          pupilMM:(sm.pr/sm.r)*11.7};
}
const toWorld=(x,y,z=0)=>new THREE.Vector3(x, H-y, z);   // css px -> world

/* ------ real anatomical contours: 64-angle polar profiles per frame ------ */
const smProf = {p:null, i:null};
function sampleProfiles(E){
  const T = window.EYE_TRACK;
  const A = (T && T.A) || 64;
  const s = Math.max(W/VID_W, H/VID_H);
  const p = new Float32Array(A), q = new Float32Array(A);
  if (T && T.pupil && video.readyState>=2 && !isNaN(video.currentTime)){
    const n=T.n, total=2*n-1;
    let g=video.currentTime*T.fps; g=((g%total)+total)%total;
    let f=g<=n-1 ? g : 2*n-2-g;
    f=Math.max(0,Math.min(n-1.001,f));
    const i=Math.floor(f), k=f-i, j=Math.min(i+1,n-1);
    for(let a=0;a<A;a++){
      p[a]=(T.pupil[i*A+a]*(1-k)+T.pupil[j*A+a]*k)*s;
      q[a]=(T.iris [i*A+a]*(1-k)+T.iris [j*A+a]*k)*s;
    }
  }else{
    for(let a=0;a<A;a++){ p[a]=E.pr; q[a]=E.r; }
  }
  if(!smProf.p){ smProf.p=p.slice(); smProf.i=q.slice(); }
  else for(let a=0;a<A;a++){
    smProf.p[a]+= (p[a]-smProf.p[a])*0.35;
    smProf.i[a]+= (q[a]-smProf.i[a])*0.35;
  }
  return {p:smProf.p, i:smProf.i, A};
}

/* ---------------- renderer / scene / camera ---------------------------- */
const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:false});
renderer.setClearColor(0x131b45, 1);
const scene = new THREE.Scene();
const FOV = 50;
const camera = new THREE.PerspectiveCamera(FOV, 1, 10, 8000);
let CAMD = 1000;

let composer, bloom;
function buildComposer(){
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(W,H), 0.85, 0.55, 0.88);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

/* ---------------- video plane with in-shader navy grade ---------------- */
const vtex = new THREE.VideoTexture(video);
vtex.colorSpace = THREE.SRGBColorSpace;
const NAVY = new THREE.Color(19/255, 27/255, 69/255);
const videoMat = new THREE.ShaderMaterial({
  uniforms:{ map:{value:vtex}, uNavy:{value:NAVY}, uBoost:{value:1.0} },
  vertexShader:`varying vec2 vUv;
    void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader:`
    uniform sampler2D map; uniform vec3 uNavy; uniform float uBoost;
    varying vec2 vUv;
    float ramp(float x, float x0, float x1, float y0, float y1){
      return mix(y0,y1,clamp((x-x0)/(x1-x0),0.,1.)); }
    void main(){
      vec3 c = texture2D(map, vUv).rgb;
      float x=vUv.x, y=1.-vUv.y;              /* css-style top-down */
      float gh = x<.34 ? ramp(x,0.,.34,.78,.45)
                : x<.62 ? ramp(x,.34,.62,.45,.06)
                : ramp(x,.62,.80,.06,0.);
      float gv  = y<.22 ? ramp(y,0.,.22,.50,0.)
                : y<.70 ? 0.
                : ramp(y,.70,1.,0.,.55);
      float a = clamp((gh+gv)*uBoost, 0., 1.);
      gl_FragColor = vec4(mix(c, uNavy, a), 1.);
    }`
});
const videoPlane = new THREE.Mesh(new THREE.PlaneGeometry(1,1), videoMat);
videoPlane.renderOrder = -1;
scene.add(videoPlane);

/* ---------------- palette ---------------------------------------------- */
const MINT   = new THREE.Color("#61d5bc");
const MINTHI = new THREE.Color("#d7fff2");
const AMBER  = new THREE.Color("#ffb45e");
const GREEN  = new THREE.Color("#7dfcb8");
const WHITE  = new THREE.Color("#ffffff");
const addMat = (color,opacity=1)=>new THREE.MeshBasicMaterial({
  color, transparent:true, opacity, blending:THREE.AdditiveBlending,
  depthWrite:false, depthTest:false, side:THREE.DoubleSide});

/* ---------------- eye-anchored group (unit = iris radius) --------------- */
const eyeGroup = new THREE.Group();
scene.add(eyeGroup);

/* dashed lock ring: 36 arc segments, unit radius 1.15 */
const dashGeos=[];
for(let s2=0;s2<36;s2++){
  const g=new THREE.RingGeometry(1.135,1.165,6,1, s2*(Math.PI*2/36), 0.096);
  dashGeos.push(g);
}
const dashRing = new THREE.Group();
const dashMat = addMat(MINT,0.55);
dashGeos.forEach(g=>dashRing.add(new THREE.Mesh(g,dashMat)));
eyeGroup.add(dashRing);

/* reticle: 4 thick arcs + 4 ticks, unit radius 1 (scaled per-frame) */
const retGroup = new THREE.Group();
const retMat = addMat(MINTHI,0.95);
for(let q=0;q<4;q++){
  retGroup.add(new THREE.Mesh(
    new THREE.RingGeometry(0.985,1.015,24,1, q*Math.PI/2+0.28, Math.PI/2-0.56), retMat));
  const tick=new THREE.Mesh(new THREE.PlaneGeometry(0.035,0.006), addMat(MINT,0.6));
  const a=q*Math.PI/2;
  tick.position.set(Math.cos(a),-Math.sin(a),0);
  tick.rotation.z=-a;
  retGroup.add(tick);
}
eyeGroup.add(retGroup);

/* sample ticks ring: 64 quads, revealed via drawRange */
function ticksGeometry(){
  const pos=[], n=64;
  for(let i=0;i<n;i++){
    const a=i/n*Math.PI*2, r0=1.22, r1=1.28, w=0.006;
    const ca=Math.cos(a), sa=-Math.sin(a), nx=-sa, ny=ca;
    const p=(r,off)=>[r*ca+nx*off, r*sa+ny*off, 0];
    const v=[p(r0,-w),p(r1,-w),p(r1,w), p(r0,-w),p(r1,w),p(r0,w)];
    v.forEach(q=>pos.push(...q));
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  return g;
}
const ticksMesh=new THREE.Mesh(ticksGeometry(), addMat(MINT,0.5));
ticksMesh.geometry.setDrawRange(0,0);
eyeGroup.add(ticksMesh);

/* sweep: rotating group with gradient beam, glow tip, fading wedge trail */
const sweepGroup=new THREE.Group();
{
  const beamGeo=new THREE.PlaneGeometry(1.5,0.012);
  beamGeo.translate(0.75,0,0);
  const beamMat=new THREE.ShaderMaterial({
    transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false,
    uniforms:{uColor:{value:MINTHI}},
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform vec3 uColor;varying vec2 vUv;
      void main(){gl_FragColor=vec4(uColor, pow(vUv.x,1.5));}`
  });
  sweepGroup.add(new THREE.Mesh(beamGeo,beamMat));
  const tip=new THREE.Mesh(new THREE.CircleGeometry(0.022,16), addMat(WHITE,0.95));
  tip.position.x=1.5;
  sweepGroup.add(tip);
  /* trail wedge: fan with per-vertex alpha, spans 1.3 rad behind the beam */
  const SEG=40, pos=[0,0,0], alp=[0];
  for(let i=0;i<=SEG;i++){
    const a=-1.3+i/SEG*1.3;
    pos.push(Math.cos(a)*1.5, Math.sin(a)*1.5, 0);
    alp.push(Math.pow(i/SEG,2)*0.30);
  }
  const idx=[];
  for(let i=1;i<=SEG;i++)idx.push(0,i,i+1);
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute("aAlpha",new THREE.Float32BufferAttribute(alp,1));
  g.setIndex(idx);
  const trailMat=new THREE.ShaderMaterial({
    transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false,
    uniforms:{uColor:{value:MINT}},
    vertexShader:`attribute float aAlpha;varying float vA;void main(){vA=aAlpha;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform vec3 uColor;varying float vA;
      void main(){gl_FragColor=vec4(uColor,vA);}`
  });
  sweepGroup.add(new THREE.Mesh(g,trailMat));
}
eyeGroup.add(sweepGroup);

/* pulse + completion rings (unit radius, scaled per-frame) */
const mkRing=(color)=>new THREE.Mesh(new THREE.RingGeometry(0.985,1.0,72), addMat(color,0));
const pulseA=mkRing(MINT), pulseB=mkRing(MINT);
const doneRing=mkRing(GREEN), shockRing=mkRing(GREEN);
eyeGroup.add(pulseA,pulseB,doneRing,shockRing);

/* lock ping ring, px-space radius set per frame */
const pingRing=mkRing(MINT);
eyeGroup.add(pingRing);

/* anatomical outlines: dynamic strips tracing the REAL pupil + iris edges */
function contourMesh(color, widthPx, opacity){
  const SEGS=64, verts=SEGS*6;
  const g=new THREE.BufferGeometry();
  const pos=new THREE.Float32BufferAttribute(new Float32Array(verts*3),3);
  pos.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("position",pos);
  const mesh=new THREE.Mesh(g, addMat(color, opacity));
  mesh.userData={w:widthPx, base:opacity};
  mesh.visible=false;
  scene.add(mesh);
  return mesh;
}
const pupilC = contourMesh(MINTHI, 2.6, 0.95);
const irisC  = contourMesh(MINT,   3.2, 0.85);
const START = 48;   /* trace starts at the top of the eye */
function updateContour(mesh, prof, A, E, reveal, fade){
  const arr=mesh.geometry.attributes.position.array;
  const w=mesh.userData.w/2;
  let o=0;
  for(let s2=0;s2<A;s2++){
    const a0=(START+s2)%A, a1=(START+s2+1)%A;
    const t0=a0/A*Math.PI*2, t1=a1/A*Math.PI*2;
    const c0=Math.cos(t0), s0=Math.sin(t0), c1=Math.cos(t1), s1=Math.sin(t1);
    const r0=prof[a0], r1=prof[a1];
    const p=(cx,cy)=>{arr[o++]=cx; arr[o++]=H-cy; arr[o++]=0;};
    const i0x=E.cx+c0*(r0-w), i0y=E.cy+s0*(r0-w), o0x=E.cx+c0*(r0+w), o0y=E.cy+s0*(r0+w);
    const i1x=E.cx+c1*(r1-w), i1y=E.cy+s1*(r1-w), o1x=E.cx+c1*(r1+w), o1y=E.cy+s1*(r1+w);
    p(i0x,i0y); p(o0x,o0y); p(o1x,o1y);
    p(i0x,i0y); p(o1x,o1y); p(i1x,i1y);
  }
  mesh.geometry.attributes.position.needsUpdate=true;
  mesh.geometry.setDrawRange(0, Math.floor(Math.min(reveal,1)*A)*6);
  mesh.material.opacity=mesh.userData.base*fade;
  mesh.visible=reveal>0;
}

/* amber anomaly flags: squares + dashed leaders (positions set per frame) */
const FLAGS=[[0.9,0.55],[2.5,0.78],[4.7,0.66]];
const flagGroup=new THREE.Group(); scene.add(flagGroup);
const flagMeshes=FLAGS.map(()=>{
  const sq=new THREE.Group();
  const mat=addMat(AMBER,0);
  const t=2.2, s2=13;
  [[0,-s2,2*s2+t,t],[0,s2,2*s2+t,t],[-s2,0,t,2*s2+t],[s2,0,t,2*s2+t]].forEach(([x,y,w,h])=>{
    const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);
    m.position.set(x,y,0); sq.add(m);
  });
  const lead=new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),
    new THREE.LineDashedMaterial({color:AMBER,transparent:true,opacity:0,dashSize:5,gapSize:6,
      blending:THREE.AdditiveBlending,depthWrite:false,depthTest:false}));
  sq.userData.lead=lead; flagGroup.add(sq,lead);
  return sq;
});

/* ---------------- GPU binary digit cloud -------------------------------- */
function glyphAtlas(){
  const c=document.createElement("canvas");c.width=128;c.height=64;
  const x=c.getContext("2d");
  x.fillStyle="#fff";x.textAlign="center";x.textBaseline="middle";
  x.font="700 52px 'JetBrains Mono',monospace";
  x.fillText("0",32,34);x.fillText("1",96,34);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;
  return t;
}
const DIGN=1500;
const digitUniforms={
  uTime:{value:0}, uCenter:{value:new THREE.Vector2()}, uR:{value:200},
  uReveal:{value:0}, uFade:{value:1}, uAtlas:{value:glyphAtlas()},
  uPR:{value:Math.min(devicePixelRatio||1,2)}
};
let digits;
{
  const rf=[],a0=[],sp=[],gl=[],sz=[],tw=[],rg=[],ord=[],zz=[],pos=[];
  for(let i=0;i<DIGN;i++){
    const ring=Math.floor(Math.random()*13);
    rf.push(0.50+0.085*ring+(Math.random()-0.5)*0.02);
    a0.push(Math.random()*Math.PI*2);
    sp.push((ring%2?-1:1)*(0.05+Math.random()*0.10));
    gl.push(Math.random()>0.5?1:0);
    sz.push(9+Math.random()*6);
    tw.push(Math.random()*Math.PI*2);
    rg.push(ring);
    ord.push(Math.random());
    zz.push((ring-6)*9+(Math.random()-0.5)*10);
    pos.push(0,0,0);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  const attr=(n,arr,it=1)=>g.setAttribute(n,new THREE.Float32BufferAttribute(arr,it));
  attr("aRf",rf);attr("aA0",a0);attr("aSp",sp);attr("aGlyph",gl);
  attr("aSize",sz);attr("aTw",tw);attr("aRing",rg);attr("aOrd",ord);attr("aZ",zz);
  const mat=new THREE.ShaderMaterial({
    transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false,
    uniforms:digitUniforms,
    vertexShader:`
      attribute float aRf,aA0,aSp,aGlyph,aSize,aTw,aRing,aOrd,aZ;
      uniform float uTime,uR,uReveal,uPR; uniform vec2 uCenter;
      varying float vGlyph,vAlpha;
      void main(){
        float ang=aA0+aSp*uTime*1.4;
        vec3 p=vec3(uCenter+vec2(cos(ang),-sin(ang))*aRf*uR, aZ);
        float pop=clamp((uReveal-aOrd)/0.06,0.,1.);
        float twk=0.45+0.55*sin(uTime*2.+aTw);
        float inside=aRf<1.0?0.5:1.0;
        float bright=mod(aRing,5.)==2. ? 1.0 : 0.0;
        vAlpha=pop*twk*inside*mix(0.34,0.9,bright);
        vGlyph=aGlyph;
        vec4 mv=modelViewMatrix*vec4(p,1.);
        gl_PointSize=aSize*uPR;
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader:`
      uniform sampler2D uAtlas; uniform float uFade;
      varying float vGlyph,vAlpha;
      void main(){
        vec2 uv=vec2(gl_PointCoord.x*0.5+vGlyph*0.5, gl_PointCoord.y);
        float a=texture2D(uAtlas,uv).a * vAlpha * uFade;
        if(a<0.01)discard;
        vec3 col=mix(vec3(0.38,0.84,0.74), vec3(0.84,1.0,0.95), step(0.6,vAlpha));
        gl_FragColor=vec4(col,a);
      }`
  });
  digits=new THREE.Points(g,mat);
  digits.visible=false;
  scene.add(digits);
}

/* ---------------- timeline (same as 2D engine) --------------------------- */
const T_ACQ0=0.2,T_ACQ1=1.7,T_SWP1=5.6,T_ANL1=8.2,T_HOLD=10.8;
const PHASES=[
  [0.0,"ACQUIRING TARGET","locking pupil centroid"],
  [T_ACQ1,"DIGITIZING IRIS","512 radial samples \u00b7 pupillometry live"],
  [T_SWP1,"ANALYZING BIOMARKERS","autonomic response model v4.2"],
  [T_ANL1,"SCAN COMPLETE","profile encrypted \u00b7 ready for review"],
];
const easeOut=t=>1-Math.pow(1-t,3);
const easeBk=t=>{const c=2.2;return 1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2)};

let running=false,t0=null,raf=null,curPhase=-1;

function flash(green){
  if(reduced)return;
  flashEl.classList.remove("pop","green");
  void flashEl.offsetWidth;
  if(green)flashEl.classList.add("green");
  flashEl.classList.add("pop");
}
function setPhase(t){
  let i=0;
  for(let k=0;k<PHASES.length;k++) if(t>=PHASES[k][0]) i=k;
  if(i===curPhase)return;
  curPhase=i;
  phaseEl.textContent=PHASES[i][1];
  subEl.textContent=PHASES[i][2];
  phaseEl.classList.toggle("done",i===3);
  if(i>0)flash(i===3);
}
const hideAll=()=>{
  [dashRing,retGroup,ticksMesh,sweepGroup,pulseA,pulseB,doneRing,shockRing,pingRing,
   pupilC,irisC].forEach(o=>o.visible=false);
  digits.visible=false;
  flagMeshes.forEach(f=>{f.children.forEach(m=>m.material.opacity=0);
    f.userData.lead.material.opacity=0;});
  [lockEl,...anomEls,doneEl].forEach(e=>e.style.opacity=0);
};
hideAll();

/* ---------------- layout ------------------------------------------------ */
function resize(){
  W=frameEl.clientWidth; H=frameEl.clientHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
  renderer.setSize(W,H,false);
  camera.aspect=W/H;
  CAMD=(H/2)/Math.tan(THREE.MathUtils.degToRad(FOV/2));
  camera.position.set(W/2,H/2,CAMD);
  camera.lookAt(W/2,H/2,0);
  camera.updateProjectionMatrix();
  const s=Math.max(W/VID_W,H/VID_H)*1.03;          /* margin for parallax */
  videoPlane.scale.set(VID_W*s,VID_H*s,1);
  videoPlane.position.set(W/2,H/2,-40);
  if(!composer)buildComposer();
  composer.setSize(W,H);
  digitUniforms.uPR.value=Math.min(devicePixelRatio||1,2);
}
addEventListener("resize",resize);
resize();

/* ---------------- per-frame update -------------------------------------- */
function place(el,x,y){el.style.left=x+"px";el.style.top=y+"px";}

function update(ts){
  if(t0===null)t0=ts;
  let t=(ts-t0)/1000;
  if(reduced)t=Math.max(t,T_ANL1+0.1);
  const E=eyeState();
  const wc=toWorld(E.cx,E.cy);
  setPhase(t);

  const prog=Math.min(Math.max((t-T_ACQ0)/(T_ANL1-T_ACQ0),0),1);
  pctEl.textContent=Math.floor(prog*100)+"%";
  barEl.style.width=(prog*100)+"%";
  pupilEl.innerHTML=E.pupilMM.toFixed(2)+" <em>mm</em>";
  const mp=(t-T_ACQ1)/(T_ANL1-T_ACQ1-0.3);
  metricEls.forEach(el=>{
    if(mp>(+el.dataset.t)/(metricEls.length+1))el.classList.add("on");
  });

  eyeGroup.position.copy(wc);
  eyeGroup.scale.setScalar(E.r);
  digitUniforms.uTime.value=t;
  digitUniforms.uCenter.value.set(wc.x,wc.y);
  digitUniforms.uR.value=E.r;

  /* camera: dolly in during acquire, gentle parallax sway after */
  if(!reduced){
    const dolly=t<T_ACQ1?1.06-0.06*easeOut(Math.min(t/T_ACQ1,1)):1.0;
    const swayX=t>=T_ACQ1?Math.sin(t*0.5)*7:0;
    const swayY=t>=T_ACQ1?Math.cos(t*0.37)*5:0;
    camera.position.set(W/2+swayX,H/2+swayY,CAMD*dolly);
    camera.lookAt(wc.x*0.06+W/2*0.94, wc.y*0.06+H/2*0.94, 0);
  }

  hidePhaseTransients(t);

  /* acquire */
  if(t>=T_ACQ0&&t<T_ACQ1){
    const p=(t-T_ACQ0)/(T_ACQ1-T_ACQ0);
    const e=easeBk(Math.min(p*1.15,1));
    const rr=2.9-(2.9-1.15)*e;
    retGroup.visible=true;
    retGroup.scale.setScalar(rr);
    retGroup.rotation.z=(1-p)*1.2;
    lockEl.textContent="LOCK "+Math.floor(p*100)+"%";
    lockEl.style.opacity=1;
    place(lockEl,E.cx,E.cy-rr*E.r-24);
    if(p>0.75){
      const k=(p-0.75)/0.25;
      pingRing.visible=true;
      pingRing.scale.setScalar((E.pr+E.r*0.9*k)/E.r);
      pingRing.material.opacity=0.8*(1-k);
    }
  }

  /* lock ring */
  if(t>=T_ACQ1){
    dashRing.visible=true;
    dashRing.rotation.z=-t*0.7;
  }

  /* trace + track the REAL pupil edge, then the REAL iris edge */
  if(t>=T_ACQ1){
    const P=sampleProfiles(E);
    const fade=t<T_ANL1?1:Math.max(1-(t-T_ANL1)*0.25, 0.55);
    const revP=(t-T_ACQ1)/0.55;                  /* pupil traces on first  */
    const revI=(t-T_ACQ1-0.45)/0.65;             /* iris follows          */
    updateContour(pupilC, P.p, P.A, E, revP, fade);
    updateContour(irisC,  P.i, P.A, E, revI, fade);
  }

  /* sweep */
  if(t>=T_ACQ1&&t<T_SWP1){
    const p=(t-T_ACQ1)/(T_SWP1-T_ACQ1);
    sweepGroup.visible=true;
    sweepGroup.rotation.z=-p*Math.PI*2*2.4;
    ticksMesh.visible=true;
    ticksMesh.geometry.setDrawRange(0,Math.floor(64*p)*6);
    videoMat.uniforms.uBoost.value=1.0+0.14*Math.sin(t*6);
  } else videoMat.uniforms.uBoost.value=1.0;

  /* digits */
  if(t>=T_ACQ1){
    digits.visible=true;
    digitUniforms.uReveal.value=t>=T_SWP1?1:Math.min((t-T_ACQ1)/(T_SWP1-T_ACQ1)*1.15,1);
    digitUniforms.uFade.value=t<T_ANL1?1:Math.max(1-(t-T_ANL1)*0.3,0.4);
  }

  /* analyze */
  if(t>=T_SWP1&&t<T_ANL1){
    const p=(t-T_SWP1)/(T_ANL1-T_SWP1);
    [pulseA,pulseB].forEach((ring,k)=>{
      const pulse=(p*3.2+k*0.5)%1;
      ring.visible=true;
      ring.scale.setScalar((E.pr+(E.r*1.28-E.pr)*easeOut(pulse))/E.r);
      ring.material.opacity=0.6*(1-pulse);
    });
    ticksMesh.visible=true;
    ticksMesh.geometry.setDrawRange(0,64*6);
    FLAGS.forEach(([fa,fr],i)=>{
      const blink=0.35+0.65*Math.max(0,Math.sin(t*5+i*2));
      const px=E.cx+Math.cos(fa)*E.r*fr, py=E.cy+Math.sin(fa)*E.r*fr;
      const sq=flagMeshes[i];
      sq.position.copy(toWorld(px,py));
      sq.children.forEach(m=>m.material.opacity=blink);
      const lx=E.cx+Math.cos(fa)*E.r*1.45, ly=E.cy+Math.sin(fa)*E.r*1.45;
      const lead=sq.userData.lead;
      lead.geometry.setFromPoints([
        toWorld(px+Math.cos(fa)*15,py+Math.sin(fa)*15),
        toWorld(lx,ly)]);
      lead.computeLineDistances();
      lead.material.opacity=blink*0.7;
      anomEls[i].style.opacity=blink;
      place(anomEls[i], lx+Math.cos(fa)*44, ly+Math.sin(fa)*16);
    });
  }

  /* complete */
  if(t>=T_ANL1){
    const dt=t-T_ANL1;
    doneRing.visible=true;
    doneRing.scale.setScalar(1.15);
    doneRing.material.opacity=0.85;
    if(dt<1.2){
      const k=dt/1.2;
      shockRing.visible=true;
      shockRing.scale.setScalar((E.r*1.15+E.r*2.0*easeOut(k))/E.r);
      shockRing.material.opacity=0.85*(1-k);
    } else shockRing.visible=false;
    doneEl.style.opacity=Math.min(dt/0.5,1);
    doneEl.style.transform="translate(-50%,-50%)";
    place(doneEl,E.cx,Math.min(E.cy+E.r*1.7,H-150));
    bloom.strength=0.85+0.35*Math.max(0,1-dt);
  } else bloom.strength=0.85;

  composer.render();
  if(t>=T_HOLD){stop();return;}
  raf=requestAnimationFrame(update);
}

function hidePhaseTransients(t){
  retGroup.visible=false; pingRing.visible=false;
  sweepGroup.visible=false;
  pulseA.visible=pulseB.visible=false;
  if(t<T_ACQ1||t>=T_SWP1)ticksMesh.visible=t>=T_SWP1&&t<T_ANL1;
  if(t<T_ANL1){doneRing.visible=shockRing.visible=false;}
  if(t<T_SWP1||t>=T_ANL1){
    flagMeshes.forEach(f=>{f.children.forEach(m=>m.material.opacity=0);
      f.userData.lead.material.opacity=0;});
    anomEls.forEach(e=>e.style.opacity=0);
  }
  if(t>=T_ACQ1)lockEl.style.opacity=0;
}

/* ---------------- idle render (video visible through WebGL) ------------- */
function idle(){
  if(running)return;
  composer.render();
  requestAnimationFrame(idle);
}
idle();

/* ---------------- controls ---------------------------------------------- */
function start(){
  if(running){stop();return;}
  running=true;t0=null;curPhase=-1;
  sm.cx=sm.cy=sm.r=sm.pr=null;
  smProf.p=smProf.i=null;
  hideAll();
  frameEl.classList.add("scanning");
  hud.classList.add("on");hud.setAttribute("aria-hidden","false");
  btn.childNodes[0].nodeValue="Scanning\u2026 ";
  raf=requestAnimationFrame(update);
}
function stop(){
  running=false;
  if(raf)cancelAnimationFrame(raf);
  hideAll();
  frameEl.classList.remove("scanning");
  hud.classList.remove("on");hud.setAttribute("aria-hidden","true");
  btn.childNodes[0].nodeValue="Run Ocular Scan ";
  metricEls.forEach(el=>el.classList.remove("on"));
  requestAnimationFrame(idle);
}
btn.addEventListener("click",start);
