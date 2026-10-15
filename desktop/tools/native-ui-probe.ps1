param([Parameter(Mandatory=$true)][int]$OwnerPid,[ValidateSet('icon','picker')][string]$Mode='icon',[string]$Capture='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ReedNativeProbe {
 public delegate bool Visitor(IntPtr hwnd,IntPtr data);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls,string title);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visit,IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr owner,Visitor visit,IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint owner);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll",EntryPoint="GetClassLongPtrW")] public static extern IntPtr GetClassIcon(IntPtr hwnd,int index);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 public struct Rect { public int Left,Top,Right,Bottom; }
}
'@
[ReedNativeProbe]::SetProcessDPIAware()|Out-Null
$script:taskHandle=[IntPtr]::Zero
$taskDeadline=[DateTime]::UtcNow.AddSeconds(10)
do {
 [ReedNativeProbe]::EnumWindows({param($hwnd,$unused)
  [uint32]$taskOwner=0;[ReedNativeProbe]::GetWindowThreadProcessId($hwnd,[ref]$taskOwner)|Out-Null
  if($taskOwner -eq $OwnerPid -and [ReedNativeProbe]::IsWindowVisible($hwnd)){
   $taskTitle=New-Object Text.StringBuilder 300;$taskClass=New-Object Text.StringBuilder 100
   [ReedNativeProbe]::GetWindowText($hwnd,$taskTitle,300)|Out-Null;[ReedNativeProbe]::GetClassName($hwnd,$taskClass,100)|Out-Null
   if(($Mode -eq 'picker' -and $taskClass.ToString() -eq '#32770' -and $taskTitle.ToString() -eq '选择文件夹') -or ($Mode -eq 'icon' -and $taskTitle.ToString() -eq 'Reed 苇')){$script:taskHandle=$hwnd;return $false}
  };return $true
 },[IntPtr]::Zero)|Out-Null
 if($script:taskHandle -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 100}
}while($script:taskHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $taskDeadline)
if($script:taskHandle -eq [IntPtr]::Zero){throw 'Owned native window unavailable'}
if($Mode -eq 'picker'){
 $taskElement=[Windows.Automation.AutomationElement]::FromHandle($script:taskHandle)
 $taskChildren=$taskElement.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
 $taskClasses=@($taskChildren|ForEach-Object{$_.Current.ClassName}|Select-Object -Unique)
  $script:taskNativeClasses=New-Object 'System.Collections.Generic.HashSet[string]'
 [ReedNativeProbe]::EnumChildWindows($script:taskHandle,{param($hwnd,$unused) $taskClass=New-Object Text.StringBuilder 100;[ReedNativeProbe]::GetClassName($hwnd,$taskClass,100)|Out-Null;$script:taskNativeClasses.Add($taskClass.ToString())|Out-Null;return $true},[IntPtr]::Zero)|Out-Null
 $taskClasses=@($taskClasses)+@($script:taskNativeClasses)
 if($taskClasses -notcontains 'DirectUIHWND'){throw ('Modern shell view missing: '+($taskClasses -join ', '))}
 if($Capture){$taskRect=New-Object ReedNativeProbe+Rect;[ReedNativeProbe]::GetWindowRect($script:taskHandle,[ref]$taskRect)|Out-Null;$taskBitmap=New-Object Drawing.Bitmap ($taskRect.Right-$taskRect.Left),($taskRect.Bottom-$taskRect.Top);$taskGraphics=[Drawing.Graphics]::FromImage($taskBitmap);try{$taskGraphics.CopyFromScreen($taskRect.Left,$taskRect.Top,0,0,$taskBitmap.Size);$taskBitmap.Save($Capture,[Drawing.Imaging.ImageFormat]::Png)}finally{$taskGraphics.Dispose();$taskBitmap.Dispose()}}
 [ReedNativeProbe]::PostMessage($script:taskHandle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
 [pscustomobject]@{modern=$true;classes=$taskClasses}|ConvertTo-Json -Compress
}else{
 $taskIcon=[ReedNativeProbe]::GetClassIcon($script:taskHandle,-14);if($taskIcon -eq [IntPtr]::Zero){throw 'Class icon unavailable'}
 $taskBitmap=[Drawing.Icon]::FromHandle($taskIcon).ToBitmap();$taskStream=New-Object IO.MemoryStream
 try{$taskBitmap.Save($taskStream,[Drawing.Imaging.ImageFormat]::Png);$taskHash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($taskStream.ToArray())).Replace('-','');[pscustomobject]@{handle=$taskIcon.ToInt64().ToString();hash=$taskHash;width=$taskBitmap.Width;height=$taskBitmap.Height}|ConvertTo-Json -Compress}finally{$taskBitmap.Dispose();$taskStream.Dispose()}
}

if($Mode -eq 'icon' -and $Capture){
 $taskBar=[ReedNativeProbe]::FindWindow('Shell_TrayWnd',$null)
 if($taskBar -ne [IntPtr]::Zero){$taskRect=New-Object ReedNativeProbe+Rect;[ReedNativeProbe]::GetWindowRect($taskBar,[ref]$taskRect)|Out-Null;$taskBitmap=New-Object Drawing.Bitmap ($taskRect.Right-$taskRect.Left),($taskRect.Bottom-$taskRect.Top);$taskGraphics=[Drawing.Graphics]::FromImage($taskBitmap);try{$taskGraphics.CopyFromScreen($taskRect.Left,$taskRect.Top,0,0,$taskBitmap.Size);$taskBitmap.Save($Capture,[Drawing.Imaging.ImageFormat]::Png)}finally{$taskGraphics.Dispose();$taskBitmap.Dispose()}}
}