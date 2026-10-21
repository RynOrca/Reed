// A native image of the chat covers the one-time HWND resize. WebView2 can
// otherwise present the old wide backing surface, whose left side is the page,
// at the new narrow window origin before its next renderer frame arrives.
use serde_json::{json,Value};
use tauri::WebviewWindow;

// CapturePreview reads the current WebView surface without the DevTools
// screenshot command's temporary compositor overrides.
fn preview(window:&WebviewWindow)->Result<Vec<u8>,String>{
    use webview2_com::{CapturePreviewCompletedHandler,Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};
    use windows::Win32::{Foundation::HGLOBAL,System::Com::{StructuredStorage::CreateStreamOnHGlobal,STATSTG,STATFLAG_NONAME,STREAM_SEEK_SET}};
    let(tx,rx)=std::sync::mpsc::channel();let failure=tx.clone();
    window.with_webview(move|platform|{
        let result=(||->windows::core::Result<()>{unsafe{
            let core=platform.controller().CoreWebView2()?;
            let stream=CreateStreamOnHGlobal(HGLOBAL::default(),true)?;
            let captured=stream.clone();
            let callback=CapturePreviewCompletedHandler::create(Box::new(move|status|{
                let result=(||->Result<Vec<u8>,String>{
                    status.map_err(|e|e.to_string())?;
                    let mut stat=STATSTG::default();captured.Stat(&mut stat,STATFLAG_NONAME).map_err(|e|e.to_string())?;
                    if stat.cbSize==0||stat.cbSize>64*1024*1024{return Err("聊天预览尺寸无效".into());}
                    captured.Seek(0,STREAM_SEEK_SET,None).map_err(|e|e.to_string())?;
                    let mut bytes=vec![0;stat.cbSize as usize];let mut read=0;
                    captured.Read(bytes.as_mut_ptr().cast(),bytes.len() as u32,Some(&mut read)).ok().map_err(|e|e.to_string())?;
                    if read as usize!=bytes.len(){return Err("聊天预览读取不完整".into());}Ok(bytes)
                })();let _=tx.send(result);Ok(())
            }));
            core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,&stream,&callback)?;Ok(())
        }})();if let Err(error)=result{let _=failure.send(Err(error.to_string()));}
    }).map_err(|e|e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_|"聊天预览超时".to_owned())?
}

fn cdp(window:&WebviewWindow,method:&str,params:Value)->Result<Value,String>{
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler,CoTaskMemPWSTR};
    let(tx,rx)=std::sync::mpsc::channel();let failure=tx.clone();let method=method.to_owned();
    window.with_webview(move|platform|{
        let result=(||->windows::core::Result<()>{unsafe{
            let core=platform.controller().CoreWebView2()?;
            let method=CoTaskMemPWSTR::from(method.as_str());let params=params.to_string();let params=CoTaskMemPWSTR::from(params.as_str());
            let callback=CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move|status,result|{
                let value=if status.is_ok(){serde_json::from_str(&result).map_err(|e|e.to_string())}else{Err(format!("{status:?}"))};
                let _=tx.send(value);Ok(())
            }));
            core.CallDevToolsProtocolMethod(*method.as_ref().as_pcwstr(),*params.as_ref().as_pcwstr(),&callback)?;Ok(())
        }})();if let Err(error)=result{let _=failure.send(Err(error.to_string()));}
    }).map_err(|e|e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_|"聊天换帧超时".to_owned())?
}

#[repr(C)]
struct BitmapInfo{size:u32,width:i32,height:i32,planes:u16,bits:u16,compression:u32,image_size:u32,xppm:i32,yppm:i32,used:u32,important:u32,color:u32}
#[repr(C)]struct Point{x:i32,y:i32}
#[repr(C)]struct Size{width:i32,height:i32}
#[link(name="gdi32")]
extern "system"{fn CreateDIBSection(dc:isize,info:*const BitmapInfo,usage:u32,bits:*mut *mut u8,section:isize,offset:u32)->isize;fn DeleteObject(object:isize)->i32;fn CreateCompatibleDC(dc:isize)->isize;fn SelectObject(dc:isize,object:isize)->isize;fn DeleteDC(dc:isize)->i32;}
#[link(name="user32")]
extern "system"{
    fn CreateWindowExW(ex:u32,class:*const u16,title:usize,style:u32,x:i32,y:i32,w:i32,h:i32,parent:isize,menu:usize,instance:usize,param:usize)->isize;
    fn UpdateLayeredWindow(hwnd:isize,dest_dc:isize,dest:*const Point,size:*const Size,source_dc:isize,source:*const Point,key:u32,blend:usize,flags:u32)->i32;
    fn ShowWindow(hwnd:isize,command:i32)->i32;
    fn DestroyWindow(hwnd:isize)->i32;
}

pub struct CollapseCover{pub hwnd:isize,bitmap:isize,window:WebviewWindow}
impl CollapseCover{
    pub fn capture(window:&WebviewWindow,chat_width:u32,rightward:bool)->Result<Self,String>{
        let size=window.inner_size().map_err(|e|e.to_string())?;let scale=window.scale_factor().map_err(|e|e.to_string())?;
        // Crop the native preview in memory, leaving the live raster unchanged.
        let bytes=preview(window)?;
        if let Some(out)=std::env::var_os("SUMMON_TEST_COVER_OUT"){
            let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
            let _=std::fs::write(std::path::PathBuf::from(out).join(format!("cover-{stamp}.png")),&bytes);
        }
        let image=tauri::image::Image::from_bytes(&bytes).map_err(|e|e.to_string())?;
        // WebView2 rounds its DPI-scaled viewport independently from Tauri's
        // physical inner size. At 150% scaling the preview can be one pixel
        // wider; anchor the crop to the preview without shifting its screen
        // origin by that rounding difference.
        if image.height().abs_diff(size.height)>2||image.width().abs_diff(size.width)>2||chat_width>size.width||image.width()<chat_width||image.height()==0{return Err(format!("聊天截图尺寸与原生窗口不一致：预览{}×{}，窗口{}×{}，聊天宽度{}",image.width(),image.height(),size.width,size.height,chat_width));}
        let crop_x=if rightward{0}else{image.width().saturating_sub(chat_width)};
        let screen_x=if rightward{0}else{size.width.saturating_sub(chat_width)};
        let mut rgba=Vec::with_capacity(chat_width as usize*size.height as usize*4);
        // Always allocate exactly the native bitmap height. Crop an extra bottom
        // pixel or repeat the last row when WebView2 rounded down instead.
        for y in 0..size.height {
            let offset=(y.min(image.height()-1) as usize*image.width() as usize+crop_x as usize)*4;
            rgba.extend_from_slice(&image.rgba()[offset..offset+chat_width as usize*4]);
        }
        let info=BitmapInfo{size:40,width:chat_width as i32,height:-(size.height as i32),planes:1,bits:32,compression:0,image_size:0,xppm:0,yppm:0,used:0,important:0,color:0};
        let mut bits=std::ptr::null_mut();let bitmap=unsafe{CreateDIBSection(0,&info,0,&mut bits,0,0)};
        if bitmap==0||bits.is_null(){return Err(std::io::Error::last_os_error().to_string());}
        unsafe{let destination=std::slice::from_raw_parts_mut(bits,rgba.len());for(source,target)in rgba.chunks_exact(4).zip(destination.chunks_exact_mut(4)){target.copy_from_slice(&[source[2],source[1],source[0],source[3]]);}}
        let parent=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
        let origin=window.outer_position().map_err(|e|e.to_string())?;
        let radius=(14.0*scale) as i32;
        let(tx,rx)=std::sync::mpsc::channel();
        window.run_on_main_thread(move||{
            let class=[83u16,84,65,84,73,67,0];
            // An owned popup has its own compositor surface. A child STATIC
            // shares the parent's resize invalidation and can expose the old
            // WebView texture before its next GDI paint.
            // Upload the complete image before showing this surface. A visible
            // STATIC + STM_SETIMAGE can expose an unpainted DWM surface while
            // the owner is resized, even after synchronous WM_PAINT.
            let mut hwnd=unsafe{CreateWindowExW(0x080800a0,class.as_ptr(),0,0x80000000|0x08000000,origin.x+screen_x as i32,origin.y,chat_width as i32,size.height as i32,parent,0,0,0)};
            if hwnd!=0{unsafe{
                #[link(name="gdi32")]extern "system"{fn CreateRoundRectRgn(l:i32,t:i32,r:i32,b:i32,w:i32,h:i32)->isize;}
                #[link(name="user32")]extern "system"{fn SetWindowRgn(hwnd:isize,region:isize,redraw:i32)->i32;}
                let region=CreateRoundRectRgn(0,0,chat_width as i32+1,size.height as i32+1,radius*2,radius*2);
                if region!=0&&SetWindowRgn(hwnd,region,0)==0{DeleteObject(region);}
                let dc=CreateCompatibleDC(0);
                let previous=if dc!=0{SelectObject(dc,bitmap)}else{0};
                let destination=Point{x:origin.x+screen_x as i32,y:origin.y};let source=Point{x:0,y:0};
                let dimensions=Size{width:chat_width as i32,height:size.height as i32};
                let uploaded=if dc!=0{UpdateLayeredWindow(hwnd,0,&destination,&dimensions,dc,&source,0,0,4)}else{0};
                if dc!=0{SelectObject(dc,previous);DeleteDC(dc);}
                if uploaded==0{DestroyWindow(hwnd);hwnd=0;}else{ShowWindow(hwnd,4);}
            }}
            let _=tx.send(hwnd);
        }).map_err(|e|{unsafe{DeleteObject(bitmap);};e.to_string()})?;
        let hwnd=rx.recv().map_err(|e|e.to_string())?;
        if hwnd==0{unsafe{DeleteObject(bitmap);};return Err("无法准备聊天换帧保护".into());}
        // Present the independent cover before moving the window underneath it.
        #[link(name="dwmapi")]extern "system"{fn DwmFlush()->i32;}
        unsafe{DwmFlush();}
        Ok(Self{hwnd,bitmap,window:window.clone()})
    }
    pub fn wait_for_chat_frame(&self)->Result<(),String>{
        cdp(&self.window,"Runtime.evaluate",json!({"expression":"new Promise(resolve=>{let done=false;const finish=()=>{if(!done){done=true;resolve(innerWidth);}};requestAnimationFrame(()=>requestAnimationFrame(finish));setTimeout(finish,150);})","awaitPromise":true,"returnByValue":true}))?;
        // Force the resized renderer's raster before uncovering the live chat.
        preview(&self.window)?;
        #[link(name="dwmapi")]extern "system"{fn DwmFlush()->i32;}
        unsafe{DwmFlush();}Ok(())
    }
}
impl Drop for CollapseCover{fn drop(&mut self){let hwnd=self.hwnd;let bitmap=self.bitmap;let _=self.window.run_on_main_thread(move||unsafe{DestroyWindow(hwnd);DeleteObject(bitmap);});}}
