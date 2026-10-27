const words=new Intl.Segmenter('zh',{granularity:'word'}),characters=new Intl.Segmenter('zh',{granularity:'grapheme'});

/** Add whole segments while the title plus its ellipsis stays within the code-point limit. */
function prefix(text:string,segmenter:Intl.Segmenter,limit:number):string {
  let title='';
  for(const {segment} of segmenter.segment(text)){
    if([...title,...segment].length>=limit)break;
    title+=segment;
  }
  return title.replace(/[\s，,、。.!！?？:：;；-]+$/u,'');
}

/** Activity titles are bounded once, at the display producer, without cutting a word; an oversized first word keeps whole characters. */
export function activityTitle(text:string,limit=48):string {
  const line=text.split(/[\r\n]/u)[0]!.trim();
  if([...line].length<=limit)return line;
  return (prefix(line,words,limit)||prefix(line,characters,limit))+'…';
}
