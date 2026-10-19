use serde_json::{json, Value};
use std::{collections::HashSet, sync::{mpsc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::{Emitter, Manager, WebviewUrl};

#[derive(Default)]
pub struct BrowserWorkspace { failed: Mutex<HashSet<String>>, prewarming:AtomicBool }

pub fn prewarm(app:&tauri::AppHandle){
    if app.state::<BrowserWorkspace>().prewarming.swap(true,Ordering::SeqCst){return;}
    let handle=app.clone();
    std::thread::spawn(move || {
        let result=request(handle,json!({"surface":"preview","method":"ensure"}));
        crate::startup_log(&format!("Browser background prewarm: {result:?}"));
    });
}

fn label(surface: &str) -> Result<&'static str, String> {
    match surface { "preview" => Ok("reed-browser-preview"), "agent" => Ok("reed-browser-agent"), _ => Err("无效浏览器视图".into()) }
}
fn allowed_navigation(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank"
}
fn ensure(app: &tauri::AppHandle, surface: &str) -> Result<Value, String> {
    let target=label(surface)?;
    if app.get_webview_window(target).is_some() { return Ok(json!({"engine":"webview2","reused":true})); }
    if app.state::<BrowserWorkspace>().failed.lock().map_err(|_|"浏览器状态不可用")?.contains(target) { return Err("本次浏览器初始化失败，已停止自动重试；请重新启动应用后再试".into()); }
    let started=Instant::now();
    let profile=crate::profile::directory().map_err(|e|e.to_string())?.join("browser-workspace");
    std::fs::create_dir_all(&profile).map_err(|e|e.to_string())?;
    let handle=app.clone();
    let titles=app.clone();
    let selection=surface=="preview";
    let builder=tauri::WebviewWindowBuilder::new(app,target,WebviewUrl::External("about:blank".parse().unwrap()))
        .title(if selection {"Reed 网页预览"}else{"Reed 网页验收"})
        .visible(false).skip_taskbar(true).decorations(false).shadow(false).resizable(false).inner_size(1280.,800.)
        .data_directory(profile)
        .initialization_script(if selection {include_str!("browser_selection.js")}else{""})
        .on_document_title_changed(move |_,title|{if selection{let _=titles.emit_to("main","browser-title",json!({"title":title}));}})
        .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
        .on_navigation(move |url|{
            if selection && url.scheme()=="reed-selection" {
                let fields:std::collections::HashMap<_,_>=url.query_pairs().into_owned().collect();
                let text=fields.get("text").cloned().unwrap_or_default();
                if !text.trim().is_empty() && text.len()<=16000 {
                    let _=handle.emit_to("main","browser-selection",json!({"text":text,"title":fields.get("title"),"url":fields.get("url"),"context":fields.get("context"),"action":fields.get("action")}));
                }
                return false;
            }
            let allowed=allowed_navigation(url);
            if allowed&&selection{let _=handle.emit_to("main","browser-location",json!({"url":url}));}
            allowed
        });
    let result=builder.build();
    match result {
        Ok(view)=>{
            if selection{
                let host=app.clone();
                view.on_window_event(move |event|{
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop{paths,..})=event{
                        if let Some(path)=paths.iter().find(|path|path.extension().and_then(|s|s.to_str()).map(|ext|["html","htm"].contains(&ext.to_lowercase().as_str())).unwrap_or(false)){
                            let _=host.emit_to("main","browser-drop",json!({"path":path}));
                        }
                    }
                });
            }
            // A managed child HWND preserves Tauri's existing main WebviewWindow
            // identity; adding a second Tauri webview to main would invalidate it.
            #[cfg(windows)]if surface=="preview"{
                let parent=app.get_webview_window("main").ok_or("主窗口不存在")?;
                let hwnd=view.hwnd().map_err(|e|e.to_string())?.0 as isize;
                let owner=parent.hwnd().map_err(|e|e.to_string())?.0 as isize;
                #[link(name="user32")]extern "system"{fn SetParent(child:isize,parent:isize)->isize;fn GetParent(child:isize)->isize;fn GetWindowLongPtrW(hwnd:isize,index:i32)->isize;fn SetWindowLongPtrW(hwnd:isize,index:i32,value:isize)->isize;}
                unsafe{SetParent(hwnd,owner);let style=GetWindowLongPtrW(hwnd,-16);SetWindowLongPtrW(hwnd,-16,(style&!(0x80000000_u32 as isize))|0x40000000|0x04000000);if GetParent(hwnd)!=owner{let _=view.destroy();return Err("无法嵌入网页预览窗口".into());}}
            }
            Ok(json!({"engine":"webview2","reused":false,"startupMs":started.elapsed().as_millis()}))
        },
        Err(error)=>{app.state::<BrowserWorkspace>().failed.lock().map_err(|_|"浏览器状态不可用")?.insert(target.to_owned());Err(error.to_string())}
    }
}

// Called only by the trusted host or its own Agent pipe. Web content never gets
// access to this bridge. All COM/WebView operations stay on the UI thread;
// callers wait on a worker so asynchronous callbacks can be pumped normally.
pub fn request(app: tauri::AppHandle, input: Value) -> Result<Value,String> {
    let surface=input["surface"].as_str().unwrap_or("agent").to_owned();
    let target=label(&surface)?.to_owned();
    let method=input["method"].as_str().ok_or("缺少浏览器方法")?.to_owned();
    let params=input.get("params").cloned().unwrap_or(json!({}));
    let (tx,rx)=mpsc::channel();
    let handle=app.clone();
    app.run_on_main_thread(move || {
        let result=(||->Result<Option<Value>,String>{
            if method=="ensure" {return ensure(&handle,&surface).map(Some);}
            if method=="close" {
                if let Some(view)=handle.get_webview_window(&target){view.destroy().map_err(|e|e.to_string())?;}
                return Ok(Some(json!({})));
            }
            let existing=handle.get_webview_window(&target);
            if method=="visibility" {return Ok(Some(json!({"exists":existing.is_some(),"visible":existing.as_ref().map(native_visible).unwrap_or(false)})));}
            if method=="bounds" && params["visible"]==false && existing.is_none(){return Ok(Some(json!({})));}
            let view=existing.ok_or("浏览器尚未启动")?;
            if method=="bounds" {
                if surface!="preview" {return Err("只能调整预览面板".into());}
                if params["visible"]==false {
                    // SetWindowPos(SWP_SHOWWINDOW) bypasses winit's visibility
                    // cache. Hide through the same Win32 layer, not Window.hide.
                    #[cfg(windows)]{
                        #[link(name="user32")]extern "system"{fn ShowWindow(hwnd:isize,command:i32)->i32;}
                        unsafe{ShowWindow(view.hwnd().map_err(|e|e.to_string())?.0 as isize,0);}
                    }
                    #[cfg(not(windows))]view.hide().map_err(|e|e.to_string())?;
                    if native_visible(&view){return Err("网页预览未能隐藏".into());}
                    return Ok(Some(json!({})));
                }
                let number=|name:&str|params[name].as_f64().filter(|v|v.is_finite()&&v.abs()<50000.).ok_or_else(||format!("无效的预览尺寸：{name}"));
                let (x,y,w,h)=(number("x")?,number("y")?,number("width")?,number("height")?);
                if w<100. || h<100. {return Err("预览区域太小".into());}
                #[cfg(windows)]{
                    let scale=handle.get_webview_window("main").ok_or("主窗口不存在")?.scale_factor().map_err(|e|e.to_string())?;
                    let hwnd=view.hwnd().map_err(|e|e.to_string())?.0 as isize;
                    #[link(name="user32")]extern "system"{fn SetWindowPos(hwnd:isize,after:isize,x:i32,y:i32,w:i32,h:i32,flags:u32)->i32;}
                    if unsafe{SetWindowPos(hwnd,0,(x*scale).round() as i32,(y*scale).round() as i32,(w*scale).round() as i32,(h*scale).round() as i32,0x10|0x40|0x20)}==0{return Err(std::io::Error::last_os_error().to_string());}
                }
                return Ok(Some(json!({})));
            }
            if !["Page.enable","Page.navigate","Page.getFrameTree","Page.getLayoutMetrics","Page.captureScreenshot","Page.getNavigationHistory","Page.navigateToHistoryEntry","Page.reload","Runtime.evaluate","Emulation.setDeviceMetricsOverride"].contains(&method.as_str()) {return Err("不支持的浏览器方法".into());}
            if method=="Page.navigate" {
                let url:tauri::Url=params["url"].as_str().ok_or("缺少网址")?.parse().map_err(|_|"网址无效")?;
                if !allowed_navigation(&url) || !url.username().is_empty() || url.password().is_some(){return Err("只允许HTTP(S)网页".into());}
            }
            #[cfg(windows)]
            {
                use webview2_com::{CallDevToolsProtocolMethodCompletedHandler,CoTaskMemPWSTR};
                let response=tx.clone();let failure=tx.clone();
                view.with_webview(move |platform|{
                    let result=(||->windows::core::Result<()>{unsafe{
                        let core=platform.controller().CoreWebView2()?;
                        let name=CoTaskMemPWSTR::from(method.as_str());let body=params.to_string();let body=CoTaskMemPWSTR::from(body.as_str());
                        let callback=CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status,result|{
                            let value=if status.is_ok(){serde_json::from_str(&result).map_err(|e|e.to_string())}else{Err(format!("浏览器操作失败：{status:?}"))};
                            let _=response.send(value);Ok(())
                        }));
                        core.CallDevToolsProtocolMethod(*name.as_ref().as_pcwstr(),*body.as_ref().as_pcwstr(),&callback)?;
                        Ok(())
                    }})();
                    if let Err(error)=result{let _=failure.send(Err(error.to_string()));}
                }).map_err(|e|e.to_string())?;
                Ok(None)
            }
            #[cfg(not(windows))]
            {Err("内置浏览器目前仅支持Windows".into())}
        })();
        match result {Ok(Some(value))=>{let _=tx.send(Ok(value));},Err(error)=>{let _=tx.send(Err(error));},_=>{}}
    }).map_err(|e|e.to_string())?;
    rx.recv_timeout(Duration::from_secs(30)).map_err(|_|"内置浏览器没有及时响应".to_string())?
}

fn native_visible(view:&tauri::WebviewWindow)->bool{
    #[cfg(windows)]{
        #[link(name="user32")]extern "system"{fn IsWindowVisible(hwnd:isize)->i32;}
        view.hwnd().map(|hwnd|unsafe{IsWindowVisible(hwnd.0 as isize)!=0}).unwrap_or(false)
    }
    #[cfg(not(windows))]{view.is_visible().unwrap_or(false)}
}

#[tauri::command]
pub async fn browser_host(app:tauri::AppHandle,request:Value)->Result<Value,String>{
    tauri::async_runtime::spawn_blocking(move || self::request(app,request)).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn choose_html_file(window:tauri::WebviewWindow)->Result<Option<String>,String>{
    #[cfg(windows)]{
        let owner=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
        tauri::async_runtime::spawn_blocking(move || crate::native_ui::choose_html(owner)).await.map_err(|e|e.to_string())?
    }
    #[cfg(not(windows))]{Err("目前仅支持Windows".into())}
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn limits_navigation(){for url in ["https://example.org","http://localhost:1234/a","about:blank"]{assert!(allowed_navigation(&url.parse().unwrap()));}for url in ["file:///C:/secret","javascript:alert(1)","data:text/html,hi","tauri://localhost"]{assert!(!allowed_navigation(&url.parse().unwrap()));}}
    #[test]fn limits_surfaces(){assert!(label("preview").is_ok());assert!(label("agent").is_ok());assert!(label("main").is_err());}
}
