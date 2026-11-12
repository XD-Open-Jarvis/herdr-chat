export const previewKey = pane => pane?.tab && pane?.pane && pane?.terminal ? JSON.stringify([pane.tab,pane.pane,pane.terminal]) : null;
const local = value => String(value ?? '').split('/').at(-1);
export function previewPane(tree, all, tab, focusedPane) {
  const find = (node,id) => node?.id===id ? node : (node?.children??[]).map(child=>find(child,id)).find(Boolean);
  const stack=find(tree,'conversation-view');
  const page=stack?.children?.find(child=>child.id===stack.active);
  const meta=page?.children?.find(child=>child.content?.mod==='chat')?.content?.props;
  if(meta?.presentation && local(meta.owner_tab)===local(tab)) {
    const matches=all.filter(p=>p.tab===tab && local(p.tab)===local(meta.owner_tab) && local(p.pane)===local(meta.owner_pane) && local(p.terminal)===local(meta.terminal));
    return matches.length===1 ? matches[0] : null;
  }
  return all.find(p=>p.tab===tab && p.pane===focusedPane && p.terminal)??null;
}
export function fileLink(url, cwd, literal = false) {
  if(typeof url!=='string'||!url.trim())return null;
  let path=url.trim(),line=null;
  if(!literal) {
    if(/^file:\/\//i.test(path)) {
      path=path.replace(/^file:\/\/(?:localhost)?(?=\/)/i,'');
      if(/^file:/i.test(path))return null;
    } else if(/^[a-z][\w+.-]*:/i.test(path)&&! /^[a-z]:[\\/]/i.test(path))return null;
    // Separate URL metadata before decoding, so encoded # and ? remain valid
    // filename characters, while ordinary Markdown anchors never reach disk.
    const hash=path.indexOf('#');
    const fragment=hash>=0 ? path.slice(hash+1) : '';
    if(hash>=0)path=path.slice(0,hash);
    path=path.split('?')[0];
    const anchor=/^L(\d+)(?:C\d+)?(?:-L?\d+)?$/.exec(fragment);
    const suffix=/:(\d+)(?::\d+)?$/.exec(path);
    if(suffix)path=path.slice(0,suffix.index);
    line=anchor ? Number(anchor[1]) : suffix ? Number(suffix[1]) : null;
    try{path=decodeURIComponent(path);}catch{return null;}
  }
  if(!path||path.includes('\0')||/[\r\n]/.test(path))return null;
  if(!/^(?:\/|[a-z]:[\\/])/i.test(path)) {
    if(!cwd)return null;
    path=cwd.replace(/[\\/]$/,'')+'/'+path;
  }
  return {file:path,line};
}
export function previewLayout(tree) {
  const next=JSON.parse(JSON.stringify(tree));
  const find=(node,id)=>node?.id===id?node:(node?.children??[]).map(child=>find(child,id)).find(Boolean);
  const panel=find(next,'panel'),stack=find(next,'panel-body');
  if(!panel||!stack)throw new Error('The Chat layout has no file sidebar.');
  if(!stack.children.some(child=>child.id==='chat-preview'))stack.children.push({id:'chat-preview',type:'block',content:{mod:'chat-preview'}});
  panel.hidden=false;
  if(!panel.size || (!Number.isFinite(panel.size.px) && !Number.isFinite(panel.size.weight)))panel.size={px:520};panel.max=Math.max(900,panel.max??0);panel.resizable=true;
  stack.active='chat-preview';
  return next;
}
