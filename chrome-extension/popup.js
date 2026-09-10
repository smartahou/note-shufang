const $ = id => document.getElementById(id);
async function send(message){const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw new Error(r?.error||'操作失败');return r.data??r}
function setCompatButton(data){const on=!!data?.enabled;$('compat').textContent=`兼容选文：${on?'开':'关'}`;$('compat').classList.toggle('on',on);$('compat').title=on?`已对 ${data.host||'当前网站'} 解除常见的选中/右键限制`:'仅在遇到禁止选中、禁止右键的网站时开启'}

async function refreshShortcuts(){
  try{
    const list=await send({type:'popup:shortcut-status'});
    const map=new Map((list||[]).map(x=>[x.name,x.shortcut||'']));
    const textKey=map.get('clip-selection')||'';
    const shotKey=map.get('capture-region')||'';
    const el=$('shortcutStatus');
    if(!textKey||!shotKey){
      el.textContent=`${textKey||'文字快捷键未分配'} · ${shotKey||'截图快捷键未分配'} · 点击设置`;
      el.classList.add('warn');
      el.onclick=()=>send({type:'popup:open-shortcuts'}).catch(()=>{});
    }else{
      el.textContent=`${textKey} 文字 · ${shotKey} 截图`;
      el.classList.remove('warn');
      el.onclick=null;
    }
  }catch{}
}
async function refreshCompat(){try{setCompatButton(await send({type:'popup:compat-get'}));$('compat').disabled=false}catch{$('compat').disabled=true}}
async function refresh(){await refreshCompat();await refreshShortcuts();try{const base=await send({type:'note:get-base'});$('noteBase').value=base.base||base;$('statusDot').className='';await send({type:'note:status'});$('statusDot').className='ok';$('status').textContent='Note 已连接';$('clipText').disabled=false;$('capture').disabled=false}catch(e){$('statusDot').className='bad';$('status').textContent=e.message;$('clipText').disabled=true;$('capture').disabled=true}}
async function action(type){try{await send({type});window.close()}catch(e){$('status').textContent=e.message}}
$('clipText').onclick=()=>action('popup:clip-selection');
$('capture').onclick=()=>action('popup:capture-region');
$('compat').onclick=async()=>{try{const data=await send({type:'popup:compat-toggle'});setCompatButton(data);$('status').textContent=data.enabled?'已开启当前网站兼容选文':'已关闭当前网站兼容选文'}catch(e){$('status').textContent=e.message}};
$('openNote').onclick=()=>action('popup:open-note');
$('saveBase').onclick=async()=>{try{await send({type:'note:set-base',base:$('noteBase').value});await refresh()}catch(e){$('status').textContent=e.message}};
refresh();
