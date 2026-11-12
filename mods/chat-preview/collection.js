export const FILE_HEADER=44;
export function collectionPosition(files,heights,requested,viewport,trailing=0) {
 const sizes=files.map((file,i)=>heights[i]??Math.max(120,FILE_HEADER+((file.diff??'').split('\n').length+4)*18+24));
 const total=sizes.reduce((a,b)=>a+b,0)+trailing,offset=Math.max(0,Math.min(requested,Math.max(0,total-viewport)));
 let index=0,start=0;
 while(index<sizes.length-1&&start+sizes[index]<=offset){start+=sizes[index++];}
 return {offset,total,index,headerTop:Math.min(0,start+(sizes[index]??0)-offset-FILE_HEADER),sizes};
}
