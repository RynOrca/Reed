use std::sync::{Mutex,atomic::{AtomicBool,AtomicU64,Ordering}};
use tauri::Manager;
use serde_json::{json,Value};

#[derive(Clone,Copy)]
struct Expanded { original_width:f64, chat_width:f64, was_maximized:bool, target:Frame, settled:bool, rightward:bool, visible_width:u32 }
#[derive(Default)]
pub struct CanvasWindow { active:Mutex<Option<Expanded>>, revision:AtomicU64, clipping:AtomicBool }
impl CanvasWindow { pub fn is_clipping(&self)->bool{self.clipping.load(Ordering::SeqCst)} }
#[derive(Clone,Copy,Debug,PartialEq)]
struct Frame { x:i32,y:i32,width:u32,height:u32 }

fn expansion(original:Frame,work:Frame)->(Frame,u32){
    let left=(original.x as i64-work.x as i64).max(0) as u32;
    let right_space=(work.x as i64+work.width as i64-original.x as i64-original.width as i64).max(0) as u32;
    let rightward=left<240&&right_space>left;
    let room=if rightward{right_space}else{left};
    let width=original.width.saturating_mul(3).min(original.width.saturating_add(room)).min(work.width).max(1);
    let height=original.height.min(work.height).max(1);let chat=original.width.min(width);
    let x=if rightward{original.x}else{original.x-(width-original.width) as i32};
    let y=(original.y as i64).clamp(work.y as i64,work.y as i64+work.height as i64-height as i64);
    (Frame{x,y:y as i32,width,height},chat)
}
fn current(window:&tauri::WebviewWindow)->Result<Frame,String>{let p=window.outer_position().map_err(|e|e.to_string())?;let s=window.outer_size().map_err(|e|e.to_string())?;Ok(Frame{x:p.x,y:p.y,width:s.width,height:s.height})}
fn work_area(window:&tauri::WebviewWindow)->Result<Frame,String>{let monitor=window.current_monitor().map_err(|e|e.to_string())?.or(window.primary_monitor().map_err(|e|e.to_string())?).ok_or("找不到显示器工作区")?;let area=monitor.work_area();Ok(Frame{x:area.position.x,y:area.position.y,width:area.size.width,height:area.size.height})}
fn apply(window:&tauri::WebviewWindow,frame:Frame)->Result<(),String>{
    #[cfg(windows)]
    {
        let hwnd=window.hwnd().map_err(|e|e.to_string())?;
        apply_hwnd(hwnd.0 as isize,frame)?
    }
    #[cfg(not(windows))]
    {window.set_size(tauri::PhysicalSize::new(frame.width,frame.height)).map_err(|e|e.to_string())?;window.set_position(tauri::PhysicalPosition::new(frame.x,frame.y)).map_err(|e|e.to_string())?;}
    Ok(())
}
#[cfg(windows)]
fn apply_hwnd(hwnd:isize,frame:Frame)->Result<(),String>{
    #[link(name="user32")]
    extern "system" { fn SetWindowPos(hwnd:isize,after:isize,x:i32,y:i32,cx:i32,cy:i32,flags:u32)->i32; }
    if unsafe { SetWindowPos(hwnd,0,frame.x,frame.y,frame.width as i32,frame.height as i32,0x14) }==0{return Err(std::io::Error::last_os_error().to_string());}
    Ok(())
}
fn clip_edges(carrier:u32,visible:u32,rightward:bool)->(i32,i32){
    let width=visible.min(carrier) as i32;
    let left=if rightward{0}else{carrier as i32-width};(left,left+width)
}
// Resize WebView2 only at the endpoints. During motion its backing surface stays
// at the expanded size; a native region reveals it without any WM_SIZE/layout.
#[cfg(windows)]
fn clip(hwnd:isize,frame:Frame,width:u32,rightward:bool,radius:i32)->Result<(),String>{
    #[link(name="gdi32")]
    extern "system"{fn CreateRoundRectRgn(l:i32,t:i32,r:i32,b:i32,w:i32,h:i32)->isize;fn DeleteObject(object:isize)->i32;}
    #[link(name="user32")]
    extern "system"{fn SetWindowRgn(hwnd:isize,region:isize,redraw:i32)->i32;}
    let(left,right)=clip_edges(frame.width,width,rightward);
    let region=unsafe{CreateRoundRectRgn(left,0,right+1,frame.height as i32+1,radius*2,radius*2)};
    if region==0{return Err(std::io::Error::last_os_error().to_string());}
    // DWM already owns the painted backing surface. Redraw=true synchronously
    // repaints the entire WebView on every clip update and defeats this path.
    if unsafe{SetWindowRgn(hwnd,region,0)}==0{unsafe{DeleteObject(region);};return Err(std::io::Error::last_os_error().to_string());}
    Ok(())
}
fn place_clipped(window:&tauri::WebviewWindow,frame:Frame,width:u32,rightward:bool)->Result<(),String>{
    #[cfg(windows)]{
        let hwnd=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
        let radius=(14.0*window.scale_factor().map_err(|e|e.to_string())?) as i32;
        let (tx,rx)=std::sync::mpsc::channel();
        // Move + install the region in one UI callback, before the next paint.
        window.run_on_main_thread(move||{
            let result=apply_hwnd(hwnd,frame).and_then(|_|clip(hwnd,frame,width,rightward,radius));let _=tx.send(result);
        }).map_err(|e|e.to_string())?;
        rx.recv().map_err(|e|e.to_string())??;
    }
    #[cfg(not(windows))]apply(window,frame)?;
    Ok(())
}
#[cfg(windows)]
struct FramePacer(isize);
#[cfg(windows)]
impl FramePacer{
    fn new()->Self{
        #[link(name="kernel32")]extern "system"{fn CreateWaitableTimerExW(attrs:usize,name:usize,flags:u32,access:u32)->isize;}
        Self(unsafe{CreateWaitableTimerExW(0,0,2,0x1f0003)})
    }
    fn wait(&self,remaining:std::time::Duration){
        if remaining.is_zero(){return;}
        #[link(name="kernel32")]extern "system"{fn SetWaitableTimer(timer:isize,due:*const i64,period:i32,callback:usize,arg:usize,resume:i32)->i32;fn WaitForSingleObject(handle:isize,millis:u32)->u32;}
        let due=-((remaining.as_nanos()/100).max(1).min(i64::MAX as u128) as i64);
        if self.0!=0&&unsafe{SetWaitableTimer(self.0,&due,0,0,0,0)}!=0{unsafe{WaitForSingleObject(self.0,1000);};}
        else{std::thread::sleep(remaining);}
    }
}
#[cfg(windows)]
impl Drop for FramePacer{fn drop(&mut self){if self.0!=0{#[link(name="kernel32")]extern "system"{fn CloseHandle(handle:isize)->i32;}unsafe{CloseHandle(self.0);};}}}
fn reveal(window:&tauri::WebviewWindow,frame:Frame,from:u32,to:u32,rightward:bool,duration:u64,revision:u64)->Result<(u32,Vec<f64>),String>{
    if from==to{return Ok((to,vec![]));}
    #[cfg(windows)]let hwnd=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
    let radius=(14.0*window.scale_factor().map_err(|e|e.to_string())?) as i32;
    #[cfg(windows)]let pacer=FramePacer::new();
    let start=std::time::Instant::now();let mut width=from;let mut frames=vec![];
    let interval=std::time::Duration::from_nanos(16_666_667);let mut deadline=interval;
    loop{
        if window.state::<CanvasWindow>().revision.load(Ordering::SeqCst)!=revision{return Ok((width,frames));}
        let t=if duration==0{1.0}else{(start.elapsed().as_secs_f64()*1000.0/duration as f64).min(1.0)};
        let eased=t*t*(3.0-2.0*t);
        width=(from as f64+(to as f64-from as f64)*eased).round() as u32;
        #[cfg(windows)]clip(hwnd,frame,width,rightward,radius)?;
        frames.push(start.elapsed().as_secs_f64()*1000.0);
        if t>=1.0{return Ok((width,frames));}
        // Do not DwmFlush after each region: it waits for presentation *after*
        // the update, adding a whole refresh to work already done on the UI
        // thread. Absolute high-resolution deadlines avoid cumulative drift.
        let elapsed=start.elapsed();while deadline<=elapsed{deadline+=interval;}
        let wait=deadline.saturating_sub(elapsed);
        #[cfg(windows)]pacer.wait(wait);
        #[cfg(not(windows))]std::thread::sleep(wait);
        deadline+=interval;
    }
}
fn persist(expanded:bool,width:f64,maximized:bool,rightward:bool)->Result<(),String>{let path=crate::profile::directory().map_err(|e|e.to_string())?.join("canvas-window.json");let temporary=path.with_extension("json.tmp");std::fs::write(&temporary,json!({"expanded":expanded,"originalWidth":width,"wasMaximized":maximized,"rightward":rightward}).to_string()).map_err(|e|e.to_string())?;std::fs::rename(&temporary,&path).map_err(|e|e.to_string())}

#[tauri::command]
pub fn workspace_geometry(window:tauri::WebviewWindow)->Result<Value,String>{
    if window.label()!="main"{return Err("工作区只属于主窗口".into());}
    let from=current(&window)?;let(next,_)=expansion(from,work_area(&window)?);
    Ok(json!({"side":if next.x==from.x&&next.width>from.width{"right"}else{"left"}}))
}
#[tauri::command]
pub fn cancel_canvas_transition(window:tauri::WebviewWindow)->Result<(),String>{
    if window.label()!="main"{return Err("工作区只属于主窗口".into());}
    window.state::<CanvasWindow>().revision.fetch_add(1,Ordering::SeqCst);Ok(())
}
#[tauri::command]
pub async fn set_canvas_window(window:tauri::WebviewWindow,expanded:bool,duration_ms:Option<u64>,chat_width:Option<f64>)->Result<Value,String>{
    tauri::async_runtime::spawn_blocking(move || change_window(window,expanded,duration_ms.unwrap_or(if expanded{320}else{213}).min(500),chat_width)).await.map_err(|e|e.to_string())?
}
fn change_window(window:tauri::WebviewWindow,expanded:bool,duration:u64,chat_width:Option<f64>)->Result<Value,String>{
    if window.label()!="main"{return Err("画布只属于主窗口".into());}
    let state=window.state::<CanvasWindow>();let revision=state.revision.load(Ordering::SeqCst);let mut active=state.active.lock().map_err(|e|e.to_string())?;
    if expanded {
        if let Some(mut saved)=*active{
            let mut frames=vec![];
            if !saved.settled{
                let (width,times)=reveal(&window,saved.target,saved.visible_width,saved.target.width,saved.rightward,duration,revision)?;
                saved.visible_width=width;saved.settled=width==saved.target.width;frames=times;*active=Some(saved);
            }
            if saved.settled{state.clipping.store(false,Ordering::SeqCst);}
            return Ok(json!({"expanded":true,"chatWidth":saved.chat_width,"interrupted":!saved.settled,"revealFramesMs":frames}));
        }
        let was_maximized=window.is_maximized().map_err(|e|e.to_string())?;
        if was_maximized{window.unmaximize().map_err(|e|e.to_string())?;}
        let scale=window.scale_factor().map_err(|e|e.to_string())?;
        let original=current(&window)?;let work=work_area(&window)?;
        let (next,chat)=expansion(original,work);
        let original_width=original.width as f64/scale;
        persist(true,original_width,was_maximized,next.x==original.x&&next.width>original.width)?;
        let rightward=next.x==original.x&&next.width>original.width;
        // Expanding to the left moves the HWND origin. Until WebView2 paints
        // its wider, right-anchored layout, DWM can show the narrow old texture
        // at that new origin. Keep the original chat on an independent surface.
        #[cfg(windows)]let opening_cover=if !rightward&&next.width>chat{Some(crate::collapse_cover::CollapseCover::capture(&window,chat,false).map_err(|error|{crate::startup_log(&format!("Workspace expand cover: {error}"));error})?)}else{None};
        state.clipping.store(true,Ordering::SeqCst);
        *active=Some(Expanded{original_width,chat_width:chat as f64/scale,was_maximized,target:next,settled:false,rightward,visible_width:chat});
        place_clipped(&window,next,chat,rightward)?;
        // Do not reveal the drawer until the expanded renderer has a raster.
        #[cfg(windows)]if let Some(cover)=opening_cover.as_ref(){if let Err(error)=cover.wait_for_chat_frame(){crate::startup_log(&format!("Workspace expand preparation: {error}"));}}
        let (width,frames)=reveal(&window,next,chat,next.width,rightward,duration,revision)?;
        #[cfg(windows)]if let Some(cover)=opening_cover{if let Err(error)=cover.wait_for_chat_frame(){crate::startup_log(&format!("Workspace expand frame: {error}"));}}
        if let Some(saved)=active.as_mut(){saved.visible_width=width;saved.settled=width==next.width;}
        if width==next.width{state.clipping.store(false,Ordering::SeqCst);}
        Ok(json!({"expanded":true,"chatWidth":chat as f64/scale,"revealFramesMs":frames}))
    }else{
        let Some(mut saved)=*active else{return Ok(json!({"expanded":false}));};
        if let Some(width)=chat_width.filter(|v|v.is_finite()&&*v>=240.0&&*v<=10000.0){saved.original_width=width;saved.chat_width=width;}
        if window.is_maximized().map_err(|e|e.to_string())?{window.unmaximize().map_err(|e|e.to_string())?;}
        let before=current(&window)?;let work=work_area(&window)?;let scale=window.scale_factor().map_err(|e|e.to_string())?;
        let width=((saved.original_width*scale).round() as u32).min(work.width).max(1);
        let x=(if saved.rightward{before.x as i64}else{before.x as i64+before.width as i64-width as i64}).clamp(work.x as i64,work.x as i64+work.width as i64-width as i64) as i32;
        window.set_min_size(Some(tauri::LogicalSize::new(360.0_f64.min(work.width as f64/scale),280.0_f64.min(work.height as f64/scale)))).map_err(|e|e.to_string())?;
        if saved.settled{saved.target=before;saved.visible_width=before.width;}
        state.clipping.store(true,Ordering::SeqCst);saved.settled=false;*active=Some(saved);
        let (visible,frames)=reveal(&window,before,saved.visible_width,width,saved.rightward,duration,revision)?;
        saved.visible_width=visible;*active=Some(saved);
        if visible!=width{return Ok(json!({"expanded":true,"interrupted":true,"chatWidth":saved.chat_width,"revealFramesMs":frames}));}
        #[cfg(windows)]let cover=crate::collapse_cover::CollapseCover::capture(&window,width,saved.rightward).map_err(|error|{crate::startup_log(&format!("Workspace collapse cover: {error}"));error})?;
        if state.revision.load(Ordering::SeqCst)!=revision{return Ok(json!({"expanded":true,"interrupted":true,"chatWidth":saved.chat_width,"revealFramesMs":frames}));}
        place_clipped(&window,Frame{x,width,..before},width,saved.rightward)?;
        #[cfg(windows)]if let Err(error)=cover.wait_for_chat_frame(){crate::startup_log(&format!("Workspace collapse frame: {error}"));}
        if let Err(error)=persist(false,saved.original_width,saved.was_maximized,saved.rightward){let _=apply(&window,before);return Err(error);}
        *active=None;state.clipping.store(false,Ordering::SeqCst);if saved.was_maximized{window.maximize().map_err(|e|e.to_string())?;}
        Ok(json!({"expanded":false,"revealFramesMs":frames}))
    }
}

// A previous expanded frame must not become a triple-width chat on next launch.
pub fn restore_collapsed(window:&tauri::WebviewWindow)->Result<(),String>{
    let path=crate::profile::directory().map_err(|e|e.to_string())?.join("canvas-window.json");
    let content=match std::fs::read_to_string(path){Ok(text)=>text,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),Err(e)=>return Err(e.to_string())};
    let data:Value=serde_json::from_str(&content).map_err(|e|e.to_string())?;
    if data["expanded"]!=true{return Ok(());}
    let width=data["originalWidth"].as_f64().filter(|v|v.is_finite()&&*v>=240.0&&*v<=10000.0).ok_or("画布窗口记录无效")?;
    let before=current(window)?;let work=work_area(window)?;let scale=window.scale_factor().map_err(|e|e.to_string())?;let physical=(width*scale).round() as u32;let w=physical.min(work.width);
    let x=(if data["rightward"].as_bool().unwrap_or(false){before.x as i64}else{before.x as i64+before.width as i64-w as i64}).clamp(work.x as i64,work.x as i64+work.width as i64-w as i64) as i32;
    apply(window,Frame{x,width:w,height:before.height.min(work.height),y:before.y.clamp(work.y,work.y+(work.height-before.height.min(work.height)) as i32)})?;
    let maximized=data["wasMaximized"].as_bool().unwrap_or(false);persist(false,width,maximized,data["rightward"].as_bool().unwrap_or(false))?;if maximized{window.maximize().map_err(|e|e.to_string())?;}Ok(())
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn clipped_carrier_keeps_chat_edge_through_open_close_and_reversal(){
        for visible in [840,1250,1600,1250,840,2520]{
            let(left,right)=clip_edges(2520,visible,false);assert_eq!(right,2520);assert_eq!(right-left,visible as i32);
            let(left,right)=clip_edges(2520,visible,true);assert_eq!(left,0);assert_eq!(right,visible as i32);
        }
        assert_eq!(clip_edges(840,2520,false),(0,840));
    }
    #[test]fn expand_left_keeps_chat_right_and_height(){let original=Frame{x:1400,y:50,width:420,height:660};let work=Frame{x:0,y:0,width:1920,height:1040};let (next,chat)=expansion(original,work);assert_eq!(next,Frame{x:560,y:50,width:1260,height:660});assert_eq!(chat,420);}
    #[test]fn insufficient_space_stays_in_work_area(){let (next,chat)=expansion(Frame{x:20,y:100,width:420,height:660},Frame{x:0,y:0,width:900,height:700});assert_eq!(next.width,880);assert_eq!(next.x,20);assert_eq!(next.y,40);assert_eq!(chat,420);}
    #[test]fn negative_monitor_and_high_dpi_are_physical(){let (next,chat)=expansion(Frame{x:-1000,y:30,width:840,height:1320},Frame{x:-3840,y:0,width:3840,height:2100});assert_eq!(next.x,-2680);assert_eq!(next.width,2520);assert_eq!(chat,840);}
}
