// SHA-256 processes the string in blocks so large photo payloads need no second byte array.
const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function digest(text) {
  const state=new Int32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), block=new Uint8Array(64), words=new Int32Array(64);
  let filled=0, length=0;
  const rotate=(v,n)=>(v>>>n)|(v<<(32-n));
  function compress() {
    for(let i=0;i<16;i++)words[i]=(block[i*4]<<24)|(block[i*4+1]<<16)|(block[i*4+2]<<8)|block[i*4+3];
    for(let i=16;i<64;i++){const a=words[i-15],b=words[i-2];words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))|0;}
    let [a,b,c,d,e,f,g,h]=state;
    for(let i=0;i<64;i++){const first=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+words[i])|0, second=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0;h=g;g=f;f=e;e=(d+first)|0;d=c;c=b;b=a;a=(first+second)|0;}
    [a,b,c,d,e,f,g,h].forEach((v,i)=>{state[i]=(state[i]+v)|0;});
  }
  function byte(value){block[filled++]=value;length++;if(filled===64){compress();filled=0;}}
  for(let i=0;i<text.length;i++){
    let c=text.charCodeAt(i);
    if(c>=0xd800 && c<=0xdbff){const next=text.charCodeAt(i+1);if(next>=0xdc00 && next<=0xdfff){c=0x10000+((c-0xd800)<<10)+(next-0xdc00);i++;}else c=0xfffd;}
    else if(c>=0xdc00 && c<=0xdfff)c=0xfffd;
    if(c<0x80)byte(c);else if(c<0x800){byte(0xc0|(c>>>6));byte(0x80|(c&63));}else if(c<0x10000){byte(0xe0|(c>>>12));byte(0x80|((c>>>6)&63));byte(0x80|(c&63));}else{byte(0xf0|(c>>>18));byte(0x80|((c>>>12)&63));byte(0x80|((c>>>6)&63));byte(0x80|(c&63));}
  }
  const bits=length*8;byte(0x80);while(filled!==56)byte(0);
  const high=Math.floor(bits/0x100000000);for(let i=3;i>=0;i--)byte(high>>>(i*8));for(let i=3;i>=0;i--)byte(bits>>>(i*8));
  return Array.from(state,v=>(v>>>0).toString(16).padStart(8,'0')).join('');
}
const pending={};
function submissionKey(scope,data) {
  const hash=digest(JSON.stringify(data)), key='daily-report:submission:'+scope;
  let prior=pending[key];try{const saved=wx.getStorageSync(key);if(saved && saved.digest===hash && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved.id))prior=saved;}catch(_){}
  // This UUID is only a retry identifier, never a session or authentication token.
  const current=prior && prior.digest===hash?prior:{digest:hash,id:'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const v=Math.floor(Math.random()*16);return (c==='x'?v:(v&3)|8).toString(16);})};
  pending[key]=current;try{wx.setStorageSync(key,current);}catch(_){}
  return current.id;
}
module.exports={submissionKey,digest};
