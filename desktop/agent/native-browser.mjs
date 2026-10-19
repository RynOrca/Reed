import {randomUUID} from 'node:crypto';

export function createNativeBrowserTransport(send){
  const pending=new Map();let disposed=false;
  return {
    request(surface,method,params={}){
      if(disposed)return Promise.reject(Error('浏览器连接已关闭'));
      if(pending.size>=32)return Promise.reject(Error('浏览器请求过多'));
      const id=randomUUID();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(Error('内置浏览器响应超时'));},35000);
        pending.set(id,{resolve,reject,timer,surface});
        try{send({type:'native_browser_request',id,surface,method,params});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
      });
    },
    receive(message){
      if(message?.type!=='native_browser_response')return false;
      const item=pending.get(message.id);if(!item)return true;
      pending.delete(message.id);clearTimeout(item.timer);
      if(message.error)item.reject(Error(String(message.error)));else item.resolve(message.value);
      return true;
    },
    cancelSurface(surface){for(const [id,item]of pending){if(item.surface!==surface)continue;clearTimeout(item.timer);pending.delete(id);item.reject(Error('浏览器操作已取消'));}},
    close(){disposed=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('浏览器连接已关闭'));}pending.clear();},
  };
}
