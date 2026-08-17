/* Engine loader — Three.js (WebGL) with automatic Canvas2D fallback. */
function loadFallback(){
  const s = document.createElement("script");
  s.src = "js/scan.js";
  document.body.appendChild(s);
}
let hasGL = false;
try{
  const c = document.createElement("canvas");
  hasGL = !!(c.getContext("webgl2") || c.getContext("webgl"));
}catch(e){ hasGL = false; }

if (hasGL){
  import("./scan3d.js").catch(err => {
    console.warn("WebGL engine failed to load, using 2D fallback:", err);
    loadFallback();
  });
}else{
  loadFallback();
}
