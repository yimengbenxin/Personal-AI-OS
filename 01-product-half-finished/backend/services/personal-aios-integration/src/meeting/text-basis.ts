/** Compare quantities across ASR's Chinese digits and slide text's Arabic digits, without deriving new values. */
function number(token:string):number {
  const arabic=/^(\d+(?:\.\d+)?)([万亿])?$/u.exec(token);
  if(arabic)return Number(arabic[1])*(arabic[2]==='万'?10000:arabic[2]==='亿'?100000000:1);
  const digits:Record<string,number>={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  let total=0,section=0,current=0;
  for(const char of token){if(char in digits){current=digits[char]!;continue;}
    const scale=({'十':10,'百':100,'千':1000,'万':10000,'亿':100000000} as Record<string,number>)[char]!;
    if(scale>=10000){total+=(section+current)*scale;section=0;}else section+=(current||1)*scale;current=0;}
  return total+section+current;
}
export function textHasQuantityBasis(after:string,basis:string){
  const tokens=(value:string)=>[...value.normalize('NFKC').replace(/(?<=\d)\s+(?=[万亿])/gu,'').matchAll(/\d+(?:\.\d+)?[万亿]?|[零〇一二两三四五六七八九十百千万亿]+/gu)].map(row=>number(row[0]));
  const known=new Set(tokens(basis));return tokens(after).every(value=>known.has(value));
}
