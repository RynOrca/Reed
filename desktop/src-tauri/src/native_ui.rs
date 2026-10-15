#[cfg(windows)]
pub fn choose_folder(owner:isize,initial:Option<&str>)->Result<Option<String>,String>{
    use windows::{core::w,Win32::{Foundation::HWND,System::Com::{CoInitializeEx,CoUninitialize,CoCreateInstance,CoTaskMemFree,COINIT_APARTMENTTHREADED,CLSCTX_INPROC_SERVER},UI::Shell::{IFileOpenDialog,FileOpenDialog,FOS_PICKFOLDERS,FOS_FORCEFILESYSTEM,FOS_PATHMUSTEXIST,FOS_NOCHANGEDIR,SIGDN_FILESYSPATH}}};
    struct Apartment;impl Drop for Apartment{fn drop(&mut self){unsafe{CoUninitialize();}}}
    unsafe{
        CoInitializeEx(None,COINIT_APARTMENTTHREADED).ok().map_err(|e|e.to_string())?;let _apartment=Apartment;
        let dialog:IFileOpenDialog=CoCreateInstance(&FileOpenDialog,None,CLSCTX_INPROC_SERVER).map_err(|e|e.to_string())?;
        dialog.SetOptions(dialog.GetOptions().map_err(|e|e.to_string())?|FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM|FOS_PATHMUSTEXIST|FOS_NOCHANGEDIR).map_err(|e|e.to_string())?;
        dialog.SetTitle(w!("选择文件夹")).map_err(|e|e.to_string())?;
        if let Some(path)=initial.filter(|path|std::path::Path::new(path).is_dir()){
            let item:windows::Win32::UI::Shell::IShellItem=windows::Win32::UI::Shell::SHCreateItemFromParsingName(&windows::core::HSTRING::from(path),None).map_err(|e|e.to_string())?;
            dialog.SetFolder(&item).map_err(|e|e.to_string())?;
        }
        if let Err(error)=dialog.Show(Some(HWND(owner as *mut _))){if error.code().0==0x800704C7_u32 as i32{return Ok(None);}return Err(error.to_string());}
        let item=dialog.GetResult().map_err(|e|e.to_string())?;let pointer=item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|e|e.to_string())?;
        let result=pointer.to_string().map_err(|e|e.to_string());CoTaskMemFree(Some(pointer.0 as *const _));result.map(Some)
    }
}

// Explorer may keep the window-class icon after WM_SETICON changes. Update both
// sources; four process-lifetime handles avoid freeing icons still used by Shell.
#[cfg(windows)]
pub fn taskbar_icon(window:&tauri::WebviewWindow,bytes:&[u8],key:&str)->Result<(),String>{
    use std::sync::Mutex;
    use windows::Win32::{Foundation::{HWND,WPARAM,LPARAM},UI::WindowsAndMessaging::{CreateIconFromResourceEx,SendMessageW,SetClassLongPtrW,GCLP_HICON,GCLP_HICONSM,WM_SETICON,LR_DEFAULTCOLOR}};
    static ICONS:Mutex<Vec<(String,isize)>>=Mutex::new(Vec::new());
    let mut icons=ICONS.lock().map_err(|e|e.to_string())?;
    let handle=if let Some((_,handle))=icons.iter().find(|(name,_)|name==key){*handle}else{
        let icon=unsafe{CreateIconFromResourceEx(bytes,true,0x30000,256,256,LR_DEFAULTCOLOR)}.map_err(|e|e.to_string())?;let handle=icon.0 as isize;icons.push((key.to_owned(),handle));handle
    };
    let hwnd=HWND(window.hwnd().map_err(|e|e.to_string())?.0 as *mut _);
    unsafe{SetClassLongPtrW(hwnd,GCLP_HICON,handle);SetClassLongPtrW(hwnd,GCLP_HICONSM,handle);SendMessageW(hwnd,WM_SETICON,Some(WPARAM(1)),Some(LPARAM(handle)));SendMessageW(hwnd,WM_SETICON,Some(WPARAM(0)),Some(LPARAM(handle)));}
    // Running taskbar groups can prefer Shell's relaunch icon over WM_GETICON.
    // Keep that icon in the private profile; do not edit pinned user shortcuts.
    use windows::Win32::{Foundation::PROPERTYKEY,System::{Com::StructuredStorage::{PROPVARIANT,PropVariantChangeType,PVCHF_DEFAULT},Variant::VT_LPWSTR},Storage::EnhancedStorage::{PKEY_AppUserModel_RelaunchIconResource,PKEY_AppUserModel_RelaunchCommand,PKEY_AppUserModel_RelaunchDisplayNameResource},UI::Shell::PropertiesSystem::{SHGetPropertyStoreForWindow,IPropertyStore}};
    let directory=crate::profile::directory().map_err(|e|e.to_string())?.join("icons");std::fs::create_dir_all(&directory).map_err(|e|e.to_string())?;let path=directory.join(format!("{key}.ico"));
    let mut ico=vec![0,0,1,0,1,0,0,0,0,0,1,0,32,0];ico.extend_from_slice(&(bytes.len() as u32).to_le_bytes());ico.extend_from_slice(&22_u32.to_le_bytes());ico.extend_from_slice(bytes);
    if std::fs::read(&path).ok().as_deref()!=Some(ico.as_slice()){let temporary=path.with_extension("tmp");std::fs::write(&temporary,ico).map_err(|e|e.to_string())?;std::fs::rename(temporary,&path).map_err(|e|e.to_string())?;}
    unsafe{
        let store:IPropertyStore=SHGetPropertyStoreForWindow(hwnd).map_err(|e|e.to_string())?;
        fn set(store:&IPropertyStore,key:&PROPERTYKEY,text:&str)->Result<(),String>{
            let source=PROPVARIANT::from(text);let mut value=PROPVARIANT::default();
            // The SDK owns both strings; PropVariantClear must never free a Vec.
            unsafe{PropVariantChangeType(&mut value,&source,PVCHF_DEFAULT,VT_LPWSTR).map_err(|e|e.to_string())?;store.SetValue(key,&value).map_err(|e|e.to_string())}
        }
        set(&store,&PKEY_AppUserModel_RelaunchCommand,&format!("\"{}\"",std::env::current_exe().map_err(|e|e.to_string())?.display()))?;
        set(&store,&PKEY_AppUserModel_RelaunchDisplayNameResource,"Reed 苇")?;
        set(&store,&PKEY_AppUserModel_RelaunchIconResource,&path.to_string_lossy())?;store.Commit().map_err(|e|e.to_string())?;
    }
    Ok(())
}
