import {View,div} from "gpui-kit";
import {h_flex,v_flex,Editor,EditorState,TextView} from "gpui-base";
import {shared,setShared,theme,settings,spaces,panes,focused,layout,readTextFile,run} from "herdr";
import {previewPane,previewKey,fileLink} from "./preview.js";
import {diffLines,diffGroups} from "./diff.js";
const LANG={md:"markdown",markdown:"markdown",json:"json",js:"javascript",mjs:"javascript",jsx:"javascript",ts:"typescript",tsx:"typescript",py:"python",rs:"rust",go:"go",sh:"bash",yaml:"yaml",yml:"yaml",toml:"toml",html:"html",css:"css"};
const escape=text=>text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
export default class Preview extends View {
 init(){this.generation=0;this.loaded=null;this.code=null;this.text=null;this.error=null;}
 current(){
  const tab=spaces().find(space=>space.active)?.tabs?.find(tab=>tab.active)?.id;
  const pane=previewPane(layout(),panes(),tab,focused()?.pane);
  const key=previewKey(pane);
  return {key,request:(shared("chat.preview")??{})[key]??null};
 }
 open(request,cx){
  const generation=++this.generation;
  this.code?.release();this.code=null;this.text=null;this.error=null;this.limited=false;
  if(!request){cx.notify();return;}
  cx.spawn(async cx=>{
   try {
    const text=await readTextFile(request.file,{on:request.on});
    if(generation!==this.generation)return;
    if(text==null)throw new Error("This file is no longer available.");
    if(text.includes("\0"))throw new Error("Binary file · no text preview");
    this.limited=text.length>400000;
    this.text=text.slice(0,400000);
    const t=theme();
    this.code=EditorState.new({value:this.text,language:LANG[request.file.split('.').at(-1)?.toLowerCase()]??"text",readonly:true,
     line_numbers:true,soft_wrap:true,font_size:13,font_family:settings().font_family,
     syntax:{keyword:t.ansi5,string:t.ansi2,comment:t.dim,number:t.ansi3,constant:t.ansi6,type:t.ansi4,function:t.ansi4}});
   } catch(error){if(generation===this.generation){this.error=String(error?.message??error);this.text=null;}}
   if(generation===this.generation)cx.notify();
  });
 }
 update(key,patch){const pages=shared("chat.preview")??{};if(pages[key])setShared("chat.preview",{...pages,[key]:{...pages[key],...patch}});}
 diff(request,t){
  const colors={added:t.ansi2,removed:t.ansi1,hunk:t.ansi6,header:t.muted,context:t.foreground};
  return v_flex().id(`preview-diff-${request.revision}`).flex_1().min_h(0).overflow_y_scrollbar().py(12)
   .children(diffGroups(diffLines(request.change)).map((group,i)=>div().px(12).w_full().min_w(0)
    .child(TextView.html(`sidebar-diff-${request.revision}-${i}`,`<pre>${escape(group.text)}</pre>`).selectable(true).text_size(12).line_height("18px")
     .text_color(colors[group.kind]).when(Boolean(settings().font_family),el=>el.font_family(settings().font_family)))));
 }
 render(cx){
  const {key,request}=this.current(),t=theme();
  const identity=request?`${key}:${request.revision}`:null;
  if(identity!==this.loaded){this.loaded=identity;this.open(request,cx);}
  const button=(id,label,action,selected=false)=>div().id(id).px(8).py(5).rounded(6).cursor_pointer().text_size(12)
   .bg(selected?t.selected:t.background).text_color(selected?t.foreground:t.muted).hover(style=>style.bg(t.hover).text_color(t.foreground)).on_click(action).child(label);
  const markdown=/\.(md|markdown|mdown)$/i.test(request?.file??'');
  const mode=request?.mode??(markdown?'preview':'source');
  return v_flex().id("file-preview").size_full().min_w(0).min_h(0).rounded(10).overflow_hidden().bg(t.background).text_color(t.foreground)
   .border_1().border_color(t.border)
   .child(h_flex().h(44).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
    .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(request?.file.split(/[\\/]/).at(-1)??"File preview"))
    .when(Boolean(request),el=>el.child(button("preview-refresh","Refresh",()=>this.update(key,{revision:Date.now()}))))
    .child(button("preview-close","×",()=>run("layout.hide",{id:"panel"}))))
   .when(Boolean(request),el=>el
    .child(div().px(12).py(6).text_size(11).text_color(t.dim).truncate().tooltip(request.file)
     .child(`${request.on?request.on+': ':''}${request.file}${request.line?':'+request.line:''}`))
    .child(h_flex().px(8).pb(6).gap(4).items_center().border_b(1).border_color(t.border)
     .when(Boolean(request.change),row=>row.child(button("preview-mode-diff","Diff",()=>this.update(key,{mode:"diff"}),mode==='diff')))
     .when(markdown,row=>row.child(button("preview-mode-md","Preview",()=>this.update(key,{mode:"preview"}),mode==='preview')))
     .child(button("preview-mode-source",request.change?'File':'Source',()=>this.update(key,{mode:"source"}),mode==='source'))
     .child(div().flex_1()))
    .when(mode==='diff'&&Boolean(request.change),row=>row.child(this.diff(request,t)))
    .when(mode!=='diff',row=>row
     .when(Boolean(this.error),body=>body.child(div().p(16).text_size(12).text_color(t.blocked).child(this.error)))
     .when(!this.error&&this.text==null,body=>body.child(div().p(16).text_size(12).text_color(t.dim).child("Loading file…")))
     .when(this.text!=null,body=>body
      .when(mode==='preview'&&markdown,content=>content.child(div().flex_1().min_h(0).overflow_hidden().p(16)
       .child(TextView.markdown(`preview-md-${identity}`,this.text).size_full().selectable(true).scrollable(true).text_size(14).line_height("22px")
        .on_link_click((url,cx)=>{const linked=fileLink(url,request.file.replace(/[\\/][^\\/]*$/,''));
         if(linked){this.update(key,{...linked,change:null,mode:/\.(md|markdown|mdown)$/i.test(linked.file)?'preview':'source',revision:Date.now()});}
         else if(!url.startsWith("#"))cx.open_url(url);
        }))))
      .when(mode==='source',content=>content.child(Editor.new(this.code).flex_1().min_h(0)))
      .when(this.limited,content=>content.child(div().px(12).py(6).text_size(11).text_color(t.dim).child("Preview limited to 400,000 characters."))))))
   .when(!request,el=>el.child(div().flex_1().p(20).text_size(13).text_color(t.muted).child("Click a file link or a changed file in this chat to preview it here.")));
 }
 close(){this.generation++;this.code?.release();}
}
