/* Senseye — ocular scan overlay, anchored to the eye in the looping bg video */
(() => {
"use strict";
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const frame  = document.querySelector(".frame");
const video  = document.getElementById("bgvid");
const canvas = document.getElementById("scanCanvas");
const ctx    = canvas.getContext("2d");
const btn    = document.getElementById("scanBtn");
const hud    = document.getElementById("hud");
const phaseEl= document.getElementById("hudPhase");
const subEl  = document.getElementById("hudSub");
const pctEl  = document.getElementById("hudPct");
const barEl  = document.getElementById("hudBar");
/* brand: Senseye mint on navy */
const flashEl= document.getElementById("flash");
const pupilEl= document.getElementById("mPupil");
const metricEls = [...document.querySelectorAll(".hud-metrics .m")];

/* eye position in the source video, measured by per-frame pupil tracking */
const VID_W = 1920, VID_H = 1080;
const EYE_X = 0.4706, EYE_Y = 0.4935, IRIS_R = 0.1815; // fractions of vid dims

let W=0, H=0, DPR=1;
function resize(){
  DPR = Math.min(devicePixelRatio||1, 2);
  W = frame.clientWidth; H = frame.clientHeight;
  canvas.width = W*DPR; canvas.height = H*DPR;
  ctx.setTransform(DPR,0,0,DPR,0,0);
}
addEventListener("resize", resize); resize();

/* live eye state: reads the video's playback time and looks up the
   per-frame pupil/iris track, mapped through the object-fit: cover
   transform. The background is a boomerang loop (forward + reversed),
   so playback frame g maps to source frame g, or 2n-2-g on the way back. */
const sm = {cx:null, cy:null, r:null, pr:null};   // temporal smoothing
function eyeState(){
  const s = Math.max(W/VID_W, H/VID_H);
  const ox = (W - VID_W*s)/2, oy = (H - VID_H*s)/2;
  let cxv = EYE_X*VID_W, cyv = EYE_Y*VID_H,
      irv = IRIS_R*VID_H, prv = irv*0.33;         // fallback if track missing
  const T = window.EYE_TRACK;
  if (T && video && video.readyState >= 2 && !isNaN(video.currentTime)){
    const n = T.n, total = 2*n - 1;
    let g = video.currentTime * T.fps;
    g = ((g % total) + total) % total;
    let f = g <= n-1 ? g : 2*n - 2 - g;           // boomerang fold
    f = Math.max(0, Math.min(n - 1.001, f));
    const i = Math.floor(f), k = f - i, j = Math.min(i+1, n-1);
    const L = a => a[i]*(1-k) + a[j]*k;
    cxv = L(T.cx); cyv = L(T.cy); irv = L(T.ir); prv = L(T.pr);
  }
  // light exponential smoothing so quantized currentTime doesn't jitter
  const a = 0.35;
  sm.cx = sm.cx===null ? cxv : sm.cx + (cxv-sm.cx)*a;
  sm.cy = sm.cy===null ? cyv : sm.cy + (cyv-sm.cy)*a;
  sm.r  = sm.r ===null ? irv : sm.r  + (irv-sm.r )*a;
  sm.pr = sm.pr===null ? prv : sm.pr + (prv-sm.pr)*a;
  return { cx: ox + sm.cx*s, cy: oy + sm.cy*s,
           r: sm.r*s, pr: sm.pr*s,
           pupilMM: (sm.pr/sm.r)*11.7 };          // real dilation, in mm
}

/* ------------ binary orbit digits ------------ */
let bits = [];
function buildBits(r){
  bits = [];
  for(let ri=0; ri<13; ri++){
    const rf = 0.50 + 0.085*ri;
    const count = Math.floor(24 + ri*5);
    const sp = (ri%2? -1:1) * (0.05+Math.random()*0.10);
    for(let i=0;i<count;i++){
      bits.push({rf, a:Math.random()*Math.PI*2, sp,
                 ch:Math.random()>0.5?"1":"0",
                 fs:8+Math.random()*4, tw:Math.random()*Math.PI*2,
                 ring:ri, born:-1});
    }
  }
}

const FLAGS = [[0.9,0.55],[2.5,0.78],[4.7,0.66]];

/* ------------ timeline ------------ */
const T_ACQ0=0.2, T_ACQ1=1.7, T_SWP1=5.6, T_ANL1=8.2, T_HOLD=10.8;
const PHASES = [
  [0.0,   "ACQUIRING TARGET","locking pupil centroid"],
  [T_ACQ1,"DIGITIZING IRIS","512 radial samples \u00b7 pupillometry live"],
  [T_SWP1,"ANALYZING BIOMARKERS","autonomic response model v4.2"],
  [T_ANL1,"SCAN COMPLETE","profile encrypted \u00b7 ready for review"],
];
const easeOut = t => 1-Math.pow(1-t,3);
const easeBk  = t => {const c=2.2;return 1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2)};

let running=false, t0=null, raf=null, curPhase=-1, doneFade=0;

function flash(green){
  if(reduced) return;
  flashEl.classList.remove("pop","green");
  void flashEl.offsetWidth;
  if(green) flashEl.classList.add("green");
  flashEl.classList.add("pop");
}
function setPhase(t){
  let i=0;
  for(let k=0;k<PHASES.length;k++) if(t>=PHASES[k][0]) i=k;
  if(i===curPhase) return;
  curPhase=i;
  phaseEl.textContent=PHASES[i][1];
  subEl.textContent=PHASES[i][2];
  phaseEl.classList.toggle("done", i===3);
  if(i>0) flash(i===3);
}
function glow(c,b){ctx.shadowColor=c;ctx.shadowBlur=b}
function noGlow(){ctx.shadowBlur=0}
const CY="97,213,188", HOT="215,255,242", AM="255,180,94", GR="125,252,184";

function loop(ts){
  if(t0===null)t0=ts;
  let t=(ts-t0)/1000;
  if(reduced) t=Math.max(t,T_ANL1+0.1);

  const {cx,cy,r,pr,pupilMM} = eyeState();
  ctx.clearRect(0,0,W,H);
  ctx.textAlign="center";ctx.textBaseline="middle";
  setPhase(t);

  const prog=Math.min(Math.max((t-T_ACQ0)/(T_ANL1-T_ACQ0),0),1);
  pctEl.textContent=Math.floor(prog*100)+"%";
  barEl.style.width=(prog*100)+"%";

  /* live pupil metric — real measured dilation from the track */
  pupilEl.innerHTML=pupilMM.toFixed(2)+" <em>mm</em>";

  /* metric reveals */
  const mp=(t-T_ACQ1)/(T_ANL1-T_ACQ1-0.3);
  metricEls.forEach(el=>{
    if(mp > (+el.dataset.t)/(metricEls.length+1)) el.classList.add("on");
  });

  /* --- acquire: reticle slams in --- */
  if(t>=T_ACQ0 && t<T_ACQ1){
    const p=(t-T_ACQ0)/(T_ACQ1-T_ACQ0);
    const e=easeBk(Math.min(p*1.15,1));
    const rr=r*2.9-(r*2.9-r*1.15)*e, spin=(1-p)*1.2;
    glow(`rgba(${CY},1)`,22);
    ctx.strokeStyle=`rgba(${HOT},0.95)`;ctx.lineWidth=2.4;
    for(let q=0;q<4;q++){
      const a0=q*Math.PI/2+0.28+spin, a1=q*Math.PI/2+Math.PI/2-0.28+spin;
      ctx.beginPath();ctx.arc(cx,cy,rr,a0,a1);ctx.stroke();
    }
    ctx.strokeStyle=`rgba(${CY},0.6)`;ctx.lineWidth=1.6;
    for(let q=0;q<4;q++){
      const a=q*Math.PI/2+spin;
      ctx.beginPath();
      ctx.moveTo(cx+Math.cos(a)*(rr-13),cy+Math.sin(a)*(rr-13));
      ctx.lineTo(cx+Math.cos(a)*(rr+13),cy+Math.sin(a)*(rr+13));
      ctx.stroke();
    }
    ctx.fillStyle=`rgba(${HOT},0.95)`;
    ctx.font="700 13px 'JetBrains Mono',monospace";
    ctx.fillText("LOCK "+Math.floor(p*100)+"%",cx,cy-rr-22);
    if(p>0.75){
      const k=(p-0.75)/0.25;
      ctx.strokeStyle=`rgba(${CY},${0.8*(1-k)})`;ctx.lineWidth=2.5;
      ctx.beginPath();ctx.arc(cx,cy,pr+r*0.9*k,0,7);ctx.stroke();
    }
    noGlow();
  }

  /* --- lock ring, crawling dashes --- */
  if(t>=T_ACQ1){
    glow(`rgba(${CY},0.9)`,10);
    ctx.strokeStyle=`rgba(${CY},0.55)`;ctx.lineWidth=1.5;
    ctx.setLineDash([4,9]);ctx.lineDashOffset=-t*14;
    ctx.beginPath();ctx.arc(cx,cy,r*1.15,0,7);ctx.stroke();
    ctx.setLineDash([]);noGlow();
  }

  /* --- sweep --- */
  if(t>=T_ACQ1 && t<T_SWP1){
    const p=(t-T_ACQ1)/(T_SWP1-T_ACQ1);
    const sweep=p*Math.PI*2*2.4;
    ctx.save();ctx.translate(cx,cy);
    for(let k=0;k<10;k++){
      const aT=sweep-k*0.14;
      ctx.save();ctx.rotate(aT);
      const wg=ctx.createLinearGradient(0,0,r*1.5,0);
      wg.addColorStop(0,`rgba(${CY},0)`);
      wg.addColorStop(1,`rgba(${CY},${(1-k/10)*0.20})`);
      ctx.fillStyle=wg;
      ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,r*1.5,-0.13,0.02);ctx.closePath();ctx.fill();
      ctx.restore();
    }
    ctx.rotate(sweep);
    glow(`rgba(${HOT},1)`,26);
    ctx.strokeStyle=`rgba(${HOT},1)`;ctx.lineWidth=2.6;
    ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(r*1.5,0);ctx.stroke();
    ctx.fillStyle="rgba(255,255,255,0.95)";
    ctx.beginPath();ctx.arc(r*1.5,0,5,0,7);ctx.fill();
    noGlow();ctx.restore();

    const nt=Math.floor(64*p);
    ctx.strokeStyle=`rgba(${CY},0.5)`;ctx.lineWidth=1.5;
    for(let i=0;i<nt;i++){
      const a=i/64*Math.PI*2;
      ctx.beginPath();
      ctx.moveTo(cx+Math.cos(a)*r*1.24,cy+Math.sin(a)*r*1.24);
      ctx.lineTo(cx+Math.cos(a)*r*1.30,cy+Math.sin(a)*r*1.30);
      ctx.stroke();
    }
  }

  /* --- binary orbit digits --- */
  if(t>=T_ACQ1){
    const revealed=t>=T_SWP1?1:Math.min((t-T_ACQ1)/(T_SWP1-T_ACQ1)*1.15,1);
    const fade=t<T_ANL1?1:Math.max(1-(t-T_ANL1)*0.3,0.4);
    const n=Math.floor(bits.length*revealed);
    ctx.font="12px 'JetBrains Mono',monospace";
    for(let i=0;i<n;i++){
      const b=bits[i];
      if(b.born<0)b.born=t;
      const age=Math.min((t-b.born)/0.5,1);
      const a=b.a+b.sp*t*1.4, rr=b.rf*r;
      const px=cx+Math.cos(a)*rr, py=cy+Math.sin(a)*rr;
      const tw=0.45+0.55*Math.sin(t*2+b.tw);
      const inside=b.rf<1?0.5:1;
      const bright=b.ring%5===2;
      ctx.font=b.fs+"px 'JetBrains Mono',monospace";
      if(bright){
        glow(`rgba(${HOT},0.9)`,8);
        ctx.fillStyle=`rgba(${HOT},${(0.55+0.35*tw)*age*fade*inside})`;
        ctx.fillText(b.ch,px,py);noGlow();
      }else{
        ctx.fillStyle=`rgba(${CY},${(0.28+0.35*tw)*age*fade*inside})`;
        ctx.fillText(b.ch,px,py);
      }
      if(Math.random()<0.002)b.ch=b.ch==="1"?"0":"1";
    }
  }

  /* --- analyze: pulses + amber flags --- */
  if(t>=T_SWP1 && t<T_ANL1){
    const p=(t-T_SWP1)/(T_ANL1-T_SWP1);
    glow(`rgba(${CY},1)`,22);
    for(let k=0;k<2;k++){
      const pulse=(p*3.2+k*0.5)%1;
      const rr=pr+(r*1.28-pr)*easeOut(pulse);
      ctx.strokeStyle=`rgba(${CY},${0.6*(1-pulse)})`;
      ctx.lineWidth=2.6*(1-pulse)+0.6;
      ctx.beginPath();ctx.arc(cx,cy,rr,0,7);ctx.stroke();
    }
    noGlow();
    ctx.font="700 12px 'JetBrains Mono',monospace";
    FLAGS.forEach(([fa,fr],i)=>{
      const blink=0.35+0.65*Math.max(0,Math.sin(t*5+i*2));
      const px=cx+Math.cos(fa)*r*fr, py=cy+Math.sin(fa)*r*fr;
      glow(`rgba(${AM},1)`,16*blink);
      ctx.strokeStyle=`rgba(${AM},${blink})`;ctx.lineWidth=1.8;
      ctx.strokeRect(px-11,py-11,22,22);
      const lx=cx+Math.cos(fa)*r*1.45, ly=cy+Math.sin(fa)*r*1.45;
      ctx.setLineDash([3,4]);
      ctx.beginPath();
      ctx.moveTo(px+Math.cos(fa)*13,py+Math.sin(fa)*13);ctx.lineTo(lx,ly);ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=`rgba(255,200,130,${blink})`;
      ctx.fillText("\u0394 ANOM",lx+Math.cos(fa)*38,ly+Math.sin(fa)*14);
      noGlow();
    });
  }

  /* --- complete --- */
  if(t>=T_ANL1){
    const dt=t-T_ANL1;
    if(dt<1.2){
      const k=dt/1.2;
      glow(`rgba(${GR},1)`,32);
      ctx.strokeStyle=`rgba(${GR},${0.85*(1-k)})`;
      ctx.lineWidth=3.4*(1-k)+0.6;
      ctx.beginPath();ctx.arc(cx,cy,r*1.15+r*2.0*easeOut(k),0,7);ctx.stroke();
      noGlow();
    }
    glow(`rgba(${GR},0.9)`,14);
    ctx.strokeStyle=`rgba(${GR},0.85)`;ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(cx,cy,r*1.15,0,7);ctx.stroke();
    noGlow();

    const a=Math.min(dt/0.5,1);
    glow(`rgba(${GR},1)`,20);
    ctx.fillStyle=`rgba(${GR},${a})`;
    ctx.font="700 26px 'JetBrains Mono',monospace";
    ctx.fillText("S C A N   C O M P L E T E",cx,Math.min(cy+r*1.7,H-150));
    noGlow();
    ctx.fillStyle=`rgba(159,185,195,${a})`;
    ctx.font="11px 'JetBrains Mono',monospace";
    ctx.fillText("BIOMARKER PROFILE READY FOR CLINICIAN REVIEW",cx,Math.min(cy+r*1.7,H-150)+26);
  }

  /* auto wind-down */
  if(t>=T_HOLD){ stop(); return; }
  raf=requestAnimationFrame(loop);
}

function start(){
  if(running){ stop(true); return; }
  running=true; t0=null; curPhase=-1;
  sm.cx=sm.cy=sm.r=sm.pr=null;
  buildBits(eyeState().r);
  metricEls.forEach(el=>el.classList.remove("on"));
  frame.classList.add("scanning");
  hud.classList.add("on"); hud.setAttribute("aria-hidden","false");
  btn.childNodes[0].nodeValue="Scanning\u2026 ";
  raf=requestAnimationFrame(loop);
}
function stop(immediate){
  running=false;
  if(raf)cancelAnimationFrame(raf);
  ctx.clearRect(0,0,W,H);
  frame.classList.remove("scanning");
  hud.classList.remove("on"); hud.setAttribute("aria-hidden","true");
  btn.childNodes[0].nodeValue="Run Ocular Scan ";
}
btn.addEventListener("click",start);
})();
