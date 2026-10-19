use std::sync::{Mutex,atomic::{AtomicU64,Ordering}};
use tauri::Manager;
use serde_json::{json,Value};

#[derive(Clone,Copy)]
struct Expanded { original_width:f64, chat_width:f64, was_maximized:bool, target:Frame, settled:bool }
#[derive(Default)]
pub struct CanvasWindow { active:Mutex<Option<Expanded>>, revision:AtomicU64 }
#[derive(Clone,Copy,Debug,PartialEq)]
struct Frame { x:i32,y:i32,width:u32,height:u32 }

fn expansion(original:Frame,work:Frame)->(Frame,u32){
    let width=original.width.saturating_mul(3).min(work.width).max(1);
    let height=original.height.min(work.height).max(1);
    let chat=original.width.min((width*2/3).max(1));
    let right=(original.x as i64+original.width as i64).clamp(work.x as i64+width as i64,work.x as i64+work.width as i64);
    let y=(original.y as i64).clamp(work.y as i64,work.y as i64+work.height as i64-height as i64);
    (Frame{x:(right-width as i64) as i32,y:y as i32,width,height},chat)
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
#[allow(dead_code)]
fn intermediate(from:Frame,to:Frame,t:f64)->Frame{
    // Linear on purpose: at 160ms the window thread only fits a few frames, and
    // smoothstep would make the first frame almost invisible and the middle one
    // a large jump, which reads as "no animation".
    let t=t.clamp(0.0,1.0);
    let mix=|a:f64,b:f64|(a+(b-a)*t).round();
    Frame{x:mix(from.x as f64,to.x as f64) as i32,y:mix(from.y as f64,to.y as f64) as i32,width:mix(from.width as f64,to.width as f64) as u32,height:mix(from.height as f64,to.height as f64) as u32}
}
fn animate(window:&tauri::WebviewWindow,from:Frame,to:Frame,_duration:u64,revision:u64)->Result<bool,String>{
    if from==to{return Ok(true);}
    if window.state::<CanvasWindow>().revision.load(Ordering::SeqCst)!=revision{return Ok(false);}
    // WebView2 window relayouts cost 30-130ms each, so a per-frame resize only
    // fits a few uneven jumps. Snap the window once and let the page run the
    // visible content motion at display refresh rate.
    apply(window,to)?;
    Ok(true)
}
fn persist(expanded:bool,width:f64,maximized:bool)->Result<(),String>{let path=crate::profile::directory().map_err(|e|e.to_string())?.join("canvas-window.json");let temporary=path.with_extension("json.tmp");std::fs::write(&temporary,json!({"expanded":expanded,"originalWidth":width,"wasMaximized":maximized}).to_string()).map_err(|e|e.to_string())?;std::fs::rename(&temporary,&path).map_err(|e|e.to_string())}

#[tauri::command]
pub fn cancel_canvas_transition(window:tauri::WebviewWindow)->Result<(),String>{
    if window.label()!="main"{return Err("工作区只属于主窗口".into());}
    window.state::<CanvasWindow>().revision.fetch_add(1,Ordering::SeqCst);Ok(())
}
#[tauri::command]
pub async fn set_canvas_window(window:tauri::WebviewWindow,expanded:bool,duration_ms:Option<u64>)->Result<Value,String>{
    tauri::async_runtime::spawn_blocking(move || change_window(window,expanded,duration_ms.unwrap_or(160).min(500))).await.map_err(|e|e.to_string())?
}
fn change_window(window:tauri::WebviewWindow,expanded:bool,duration:u64)->Result<Value,String>{
    if window.label()!="main"{return Err("画布只属于主窗口".into());}
    let state=window.state::<CanvasWindow>();let revision=state.revision.load(Ordering::SeqCst);let mut active=state.active.lock().map_err(|e|e.to_string())?;
    if expanded {
        if let Some(mut saved)=*active{
            if !saved.settled{saved.settled=animate(&window,current(&window)?,saved.target,duration,revision)?;*active=Some(saved);}
            return Ok(json!({"expanded":true,"chatWidth":saved.chat_width,"interrupted":!saved.settled}));
        }
        let was_maximized=window.is_maximized().map_err(|e|e.to_string())?;
        if was_maximized{window.unmaximize().map_err(|e|e.to_string())?;}
        let scale=window.scale_factor().map_err(|e|e.to_string())?;
        let original=current(&window)?;let work=work_area(&window)?;
        let (next,chat)=expansion(original,work);
        let original_width=original.width as f64/scale;
        persist(true,original_width,was_maximized)?;
        *active=Some(Expanded{original_width,chat_width:chat as f64/scale,was_maximized,target:next,settled:false});
        let completed=animate(&window,original,next,duration,revision)?;
        if let Some(saved)=active.as_mut(){saved.settled=completed;}
        Ok(json!({"expanded":true,"chatWidth":chat as f64/scale}))
    }else{
        let Some(mut saved)=*active else{return Ok(json!({"expanded":false}));};
        if window.is_maximized().map_err(|e|e.to_string())?{window.unmaximize().map_err(|e|e.to_string())?;}
        let before=current(&window)?;let work=work_area(&window)?;let scale=window.scale_factor().map_err(|e|e.to_string())?;
        let width=((saved.original_width*scale).round() as u32).min(work.width).max(1);
        let x=(before.x as i64+before.width as i64-width as i64).clamp(work.x as i64,work.x as i64+work.width as i64-width as i64) as i32;
        window.set_min_size(Some(tauri::LogicalSize::new(360.0_f64.min(work.width as f64/scale),280.0_f64.min(work.height as f64/scale)))).map_err(|e|e.to_string())?;
        if saved.settled{saved.target=before;}saved.settled=false;*active=Some(saved);
        if !animate(&window,before,Frame{x,width,..before},duration,revision)?{return Ok(json!({"expanded":true,"interrupted":true,"chatWidth":saved.chat_width}));}
        if let Err(error)=persist(false,saved.original_width,saved.was_maximized){let _=apply(&window,before);return Err(error);}
        *active=None;if saved.was_maximized{window.maximize().map_err(|e|e.to_string())?;}
        Ok(json!({"expanded":false}))
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
    let x=(before.x as i64+before.width as i64-w as i64).clamp(work.x as i64,work.x as i64+work.width as i64-w as i64) as i32;
    apply(window,Frame{x,width:w,height:before.height.min(work.height),y:before.y.clamp(work.y,work.y+(work.height-before.height.min(work.height)) as i32)})?;
    let maximized=data["wasMaximized"].as_bool().unwrap_or(false);persist(false,width,maximized)?;if maximized{window.maximize().map_err(|e|e.to_string())?;}Ok(())
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn intermediate_frames_are_monotonic_and_right_anchored(){
        let from=Frame{x:1400,y:50,width:420,height:660};let to=Frame{x:560,y:50,width:1260,height:660};let mut previous=from.width;
        for i in 0..=20{let frame=intermediate(from,to,i as f64/20.0);assert!(frame.width>=previous);assert_eq!(frame.x+frame.width as i32,1820);assert_eq!(frame.height,660);previous=frame.width;}
        assert_eq!(intermediate(from,to,0.0),from);assert_eq!(intermediate(from,to,1.0),to);
        let middle=intermediate(from,to,0.43);assert_eq!(intermediate(middle,from,0.0),middle);assert_eq!(intermediate(middle,from,1.0),from);
    }
    #[test]fn expand_left_keeps_chat_right_and_height(){let original=Frame{x:1400,y:50,width:420,height:660};let work=Frame{x:0,y:0,width:1920,height:1040};let (next,chat)=expansion(original,work);assert_eq!(next,Frame{x:560,y:50,width:1260,height:660});assert_eq!(chat,420);}
    #[test]fn insufficient_space_stays_in_work_area(){let (next,chat)=expansion(Frame{x:20,y:100,width:420,height:660},Frame{x:0,y:0,width:900,height:700});assert_eq!(next.width,900);assert_eq!(next.x,0);assert_eq!(next.y,40);assert_eq!(chat,420);}
    #[test]fn negative_monitor_and_high_dpi_are_physical(){let (next,chat)=expansion(Frame{x:-1000,y:30,width:840,height:1320},Frame{x:-3840,y:0,width:3840,height:2100});assert_eq!(next.x,-2680);assert_eq!(next.width,2520);assert_eq!(chat,840);}
}
