// Read static tool arguments only. Never evaluate code recovered from a transcript.
function tokens(source) {
  const out = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) { const end=source.indexOf('\n',i); i=end<0?source.length:end; continue; }
    if (source.startsWith('/*', i)) { const end=source.indexOf('*/',i+2); i=end<0?source.length:end+2; continue; }
    const quote=source[i];
    if ('"\'`'.includes(quote)) {
      let value='', valid=true, closed=false; i++;
      while(i<source.length) {
        let c=source[i++];
        if(c===quote){closed=true;break;}
        if(quote==='`'&&c==='$'&&source[i]==='{') valid=false;
        if(c==='\\') {
          c=source[i++];
          if(c==='\n')continue;
          const escapes={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'};
          if(c==='u'||c==='x') {
            if(c==='u'&&source[i]==='{') {
              const close=source.indexOf('}',i+1), hex=close>i+1?source.slice(i+1,close):'';
              const cp=/^[0-9a-fA-F]{1,6}$/.test(hex)?parseInt(hex,16):-1;
              if(cp<0||cp>0x10ffff)valid=false;
              else{value+=String.fromCodePoint(cp);i=close+1;}
            } else {
              const length=c==='u'?4:2, hex=source.slice(i,i+length);
              if(!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex))valid=false;
              else {value+=String.fromCharCode(parseInt(hex,16));i+=length;}
            }
          } else value+=escapes[c]??c??'';
        } else value+=c;
      }
      out.push({type:'string',value:valid&&closed?value:null});continue;
    }
    const word=/^[A-Za-z_$][\w$]*/.exec(source.slice(i));
    if(word){out.push({type:'word',value:word[0]});i+=word[0].length;}
    else out.push({type:'punct',value:source[i++]});
  }
  return out;
}
function calls(source) {
  if(source.length>256000)return [];
  const ts=tokens(source), out=[];
  for(let i=0;i<ts.length-4;i++) {
    if(ts[i].type!=='word'||ts[i].value!=='tools'||ts[i+1].value!=='.'||ts[i+3].value!=='(')continue;
    const name=ts[i+2].value, first=ts[i+4];
    if(name==='apply_patch'&&first.type==='string'&&first.value!=null&&[',',')'].includes(ts[i+5]?.value))out.push({name,input:first.value});
    if(name==='exec_command'&&first.value==='{') {
      let depth=1;
      for(let j=i+5;j<ts.length&&depth;j++) {
        const t=ts[j];
        if(t.type==='punct'&&t.value==='{')depth++;
        if(t.type==='punct'&&t.value==='}')depth--;
        if(depth===1&&['cmd','command'].includes(t.value)&&ts[j+1]?.value===':'&&ts[j+2]?.type==='string'
          &&ts[j+2].value!=null&&[',','}'].includes(ts[j+3]?.value))out.push({name,input:{cmd:ts[j+2].value}});
      }
    }
    if(name==='write_stdin')out.push({name,input:{}});
  }
  return out;
}
export function patchChanges(patch) {
  const files=[];let file=null;
  for(const line of patch.replace(/\r\n/g,'\n').split('\n')) {
    const header=/^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if(header) {
      file={path:header[2],added:header[1]==='Delete'?null:0,removed:header[1]==='Delete'?null:0,diff:[],operation:header[1].toLowerCase()};
      files.push(file);continue;
    }
    if(!file)continue;
    if(line.startsWith('*** Move to: ')){file.oldPath=file.path;file.path=line.slice(13);continue;}
    if(line.startsWith('*** ')){if(line==='*** End Patch')file=null;continue;}
    if(line.startsWith('+'))file.added++;
    if(line.startsWith('-'))file.removed++;
    file.diff.push(line);
  }
  return files.map(file=>({...file,diff:file.diff.join('\n')}));
}
const cache=new WeakMap();
export function toolDetails(item) {
  let known=cache.get(item);
  if(!known||known.source!==item.input||known.name!==item.name) {
    let input=item.input;
    if(typeof input==='string'){try{input=JSON.parse(input);}catch{}}
    const rawName=item.name.split(/[./]/).at(-1), wrapper=rawName==='exec';
    const embedded=wrapper&&typeof input==='string'?calls(input):[];
    const actions=embedded.length?embedded:[{name:rawName,input}];
    const changes=[],commands=[];let wait=false;
    for(const action of actions) {
      if(action.name==='apply_patch'&&typeof action.input==='string')changes.push(...patchChanges(action.input));
      else if(/^(exec_command|Bash|shell|command_execution)$/.test(action.name)) {
        const command=action.input?.cmd??action.input?.command;
        if(typeof command==='string')commands.push(command);
        else if(Array.isArray(command))commands.push(command.join(' '));
      } else if(action.name==='write_stdin')wait=true;
      else if(/^(Edit|MultiEdit)$/.test(action.name)&&action.input?.file_path) {
        const edits=action.input.edits??[action.input];
        if(edits.every(edit=>typeof edit.old_string==='string'&&typeof edit.new_string==='string'&&!edit.replace_all)) {
          const lines=value=>value?value.replace(/\n$/,'').split('\n'):[];
          const removed=edits.flatMap(edit=>lines(edit.old_string)),added=edits.flatMap(edit=>lines(edit.new_string));
          changes.push({path:action.input.file_path,added:added.length,removed:removed.length,operation:'update',
            diff:[...removed.map(line=>'-'+line),...added.map(line=>'+'+line)].join('\n')});
        }
      }
    }
    const name=changes.length?'Edit':commands.length?'Bash':wait?'Wait':wrapper?'Tool script':item.name;
    const short=path=>path.split(/[\\/]/).at(-1);
    const summary=changes.length?[changes.map(file=>short(file.path)).join(', '),...commands].join('; '):commands.length?commands.join('; '):wait?'Command output':wrapper?'Run tool script':item.summary;
    const patches=actions.filter(action=>action.name==='apply_patch').map(action=>action.input);
    const displayInput=changes.length?(patches.length?[...patches,...commands].join('\n'):input)
      :commands.length?commands.join('\n'):input;
    known={source:item.input,name:item.name,wrapper,isPatch:patches.length>0,details:{name,summary,changes,commands,displayInput}};cache.set(item,known);
  }
  const result = typeof item.result === 'string' ? item.result : '';
  const patchFailed = known.isPatch && /(?:^|\n)(?:apply_patch verification failed:|Failed to find expected lines|Error:)/i.test(result);
  const wrapperFailed = known.wrapper && (/(?:^|\n)Error:/i.test(result) || /"(?:isError)"\s*:\s*true|"exit_code"\s*:\s*[1-9]\d*/.test(result));
  const failed = Boolean(item.error) || patchFailed || wrapperFailed;
  return {...item,...known.details,error:failed};
}
export function withChanges(entries) {
  const result=[];let changed=new Map(),start=null;
  const flush=()=>{
    if(changed.size)result.push({kind:'changes',key:`changes-${start}`,files:[...changed.values()]});
    changed=new Map();start=null;
  };
  for(const entry of entries) {
    if((entry.kind==='user'&&!entry.command)||(entry.kind==='notice'&&entry.event==='completed'))flush();
    result.push(entry);
    if(entry.kind==='tools')for(const raw of entry.items) {
      // Only acknowledged successful calls can claim an applied change.
      const detail = toolDetails(raw);
      if(raw.result===null||detail.error)continue;
      for(const file of detail.changes) {
        start??=entry.key;
        const previous=changed.get(file.path);
        changed.set(file.path,previous?{...file,added:previous.added==null||file.added==null?null:previous.added+file.added,
          removed:previous.removed==null||file.removed==null?null:previous.removed+file.removed,diff:previous.diff+'\n'+file.diff}:file);
      }
    }
  }
  flush();return result;
}
export function changeOverview(files) {
  const parts=files.map(file=>file.path.split(/[\\/]/));
  const prefix=parts[0]?.slice(0,-1)??[];
  while(prefix.length&&!parts.every(path=>prefix.every((part,index)=>path[index]===part)))prefix.pop();
  const total=field=>files.every(file=>Number.isFinite(file[field]))?files.reduce((sum,file)=>sum+file[field],0):null;
  return {added:total('added'),removed:total('removed'),labels:parts.map(path=>path.slice(prefix.length).join('/'))};
}
