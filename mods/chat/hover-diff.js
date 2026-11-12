export function sidebarVisible(tree) {
 const find=node=>node?.id==='panel'?node:(node?.children??[]).map(find).find(Boolean);
 const panel=find(tree);return Boolean(panel&&!panel.hidden);
}
export function hoverGeometry(row,viewport,blockWidth) {
 const above=Math.max(0,row.y-viewport.y),below=Math.max(0,viewport.y+viewport.height-row.y-row.height);
 const up=above>below;
 return {anchor:up?'bottom_left':'top_left',width:Math.max(160,blockWidth-24),height:Math.min(360,Math.max(100,(up?above:below)-12))};
}
