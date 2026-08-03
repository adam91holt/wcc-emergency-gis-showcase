function srgb(c){c/=255; return c<=0.03928? c/12.92 : Math.pow((c+0.055)/1.055,2.4);}
function lum(hex){
  hex=hex.replace('#','');
  const r=parseInt(hex.substring(0,2),16), g=parseInt(hex.substring(2,4),16), b=parseInt(hex.substring(4,6),16);
  return 0.2126*srgb(r)+0.7152*srgb(g)+0.0722*srgb(b);
}
function ratio(a,b){
  const l1=lum(a), l2=lum(b);
  const lighter=Math.max(l1,l2), darker=Math.min(l1,l2);
  return (lighter+0.05)/(darker+0.05);
}
const pairs = process.argv.slice(2);
for (const p of pairs) {
  const [a,b,label] = p.split(',');
  console.log((label||`${a} vs ${b}`), ratio(a,b).toFixed(2));
}
