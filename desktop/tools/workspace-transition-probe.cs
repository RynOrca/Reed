// Sample only the owned Reed window. White ratios concern two interior patches,
// not intentional white content elsewhere on the desktop or on arbitrary pages.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class WorkspaceTransitionProbe {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr h,IntPtr region);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] static extern int GetRgnBox(IntPtr region,out Rect rect);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr region);
  struct Rect { public int Left,Top,Right,Bottom; }
  public class Sample {
    public long ms;public int width,height,left,top,visibleWidth,clipLeft;public double leftWhite,rightWhite,leftCanary,rightCanary;public string mode;public bool leftOwned,rightOwned;
  }
  static void Ratios(byte[] pixels,int stride,int offset,out double whiteRatio,out double canaryRatio){
    int white=0,hits=0,total=0;
    for(int x=offset+4;x<offset+160;x+=4)for(int y=4;y<120;y+=4){int i=y*stride+x*4;int b=pixels[i],g=pixels[i+1],r=pixels[i+2];if(r>=250&&g>=250&&b>=250)white++;if(r>180&&b>130&&g<70)hits++;total++;}
    whiteRatio=(double)white/total;canaryRatio=(double)hits/total;
  }
  public static Sample[] Run(int pid,string output,int duration) {
    SetProcessDPIAware();Directory.CreateDirectory(output);
    IntPtr hwnd=Process.GetProcessById(pid).MainWindowHandle;
    if(hwnd==IntPtr.Zero)throw new Exception("Owned window unavailable");
    SetForegroundWindow(hwnd);Thread.Sleep(100);
    var samples=new List<Sample>();var watch=Stopwatch.StartNew();
    using(var sheet=new Bitmap(3200,1200))using(var sheetGraphics=Graphics.FromImage(sheet)){
      sheetGraphics.Clear(Color.DimGray);File.WriteAllText(Path.Combine(output,"ready"),"ready");
      while(watch.ElapsedMilliseconds<duration&&samples.Count<100){
        Rect rect;if(!GetWindowRect(hwnd,out rect))throw new Exception("Owned window disappeared");
        int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
        Rect clip=new Rect{Right=width};IntPtr region=CreateRectRgn(0,0,0,0);
        try{if(GetWindowRgn(hwnd,region)!=0)GetRgnBox(region,out clip);}finally{DeleteObject(region);}
        if(width<360||height<280)throw new Exception("Owned window too small");
        int left=32,right=width-192,top=Math.Min(160,height-152);
        string mode="screen";
        using(var patch=new Bitmap(320,120))using(var g=Graphics.FromImage(patch)){
          Point lp=new Point(rect.Left+left+80,rect.Top+top+60),rp=new Point(rect.Left+right+80,rect.Top+top+60);
          // GA_ROOTOWNER includes Reed's temporary native chat cover. Capturing
          // only the underlying main HWND would omit the visible protection.
          bool leftOwned=GetAncestor(WindowFromPoint(lp),3)==hwnd,rightOwned=GetAncestor(WindowFromPoint(rp),3)==hwnd;
          if(GetAncestor(GetForegroundWindow(),3)==hwnd){
            // One GPU readback per frame; two readbacks serialize refresh waits.
            using(var strip=new Bitmap(width,120))using(var sg=Graphics.FromImage(strip)){
              sg.CopyFromScreen(rect.Left,rect.Top+top,0,0,new Size(width,120));
              g.DrawImage(strip,new Rectangle(0,0,160,120),new Rectangle(left,0,160,120),GraphicsUnit.Pixel);
              g.DrawImage(strip,new Rectangle(160,0,160,120),new Rectangle(right,0,160,120),GraphicsUnit.Pixel);
            }
          }else{
            mode="PrintWindow";
            using(var full=new Bitmap(width,height))using(var fg=Graphics.FromImage(full)){
              IntPtr dc=fg.GetHdc();try{if(!PrintWindow(hwnd,dc,2))throw new Exception("Owned window capture failed");}finally{fg.ReleaseHdc(dc);}
              g.DrawImage(full,new Rectangle(0,0,160,120),new Rectangle(left,top,160,120),GraphicsUnit.Pixel);
              g.DrawImage(full,new Rectangle(160,0,160,120),new Rectangle(right,top,160,120),GraphicsUnit.Pixel);
            }
          }
          double lw,rw,lc,rc;var locked=patch.LockBits(new Rectangle(0,0,320,120),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
          try{var pixels=new byte[locked.Stride*120];Marshal.Copy(locked.Scan0,pixels,0,pixels.Length);Ratios(pixels,locked.Stride,0,out lw,out lc);Ratios(pixels,locked.Stride,160,out rw,out rc);}finally{patch.UnlockBits(locked);}
          var sample=new Sample{ms=watch.ElapsedMilliseconds,width=width,height=height,left=rect.Left,top=rect.Top,visibleWidth=clip.Right-clip.Left,clipLeft=clip.Left,leftWhite=lw,rightWhite=rw,leftCanary=lc,rightCanary=rc,mode=mode,
            leftOwned=mode=="PrintWindow"||(leftOwned&&GetAncestor(WindowFromPoint(lp),3)==hwnd),rightOwned=mode=="PrintWindow"||(rightOwned&&GetAncestor(WindowFromPoint(rp),3)==hwnd)};
          if(mode=="screen"&&sample.rightOwned&&sample.rightWhite>.85){
            Rect now;GetWindowRect(hwnd,out now);
            using(var evidence=new Bitmap(now.Right-now.Left,now.Bottom-now.Top))using(var eg=Graphics.FromImage(evidence)){
              eg.CopyFromScreen(now.Left,now.Top,0,0,evidence.Size);
              evidence.Save(Path.Combine(output,"white-"+samples.Count+".png"),ImageFormat.Png);
            }
          }
          int index=samples.Count;sheetGraphics.DrawImageUnscaled(patch,(index%10)*320,(index/10)*120);
          samples.Add(sample);
        }
        Thread.Sleep(16);
      }
      using(var used=sheet.Clone(new Rectangle(0,0,3200,Math.Max(1,(samples.Count+9)/10)*120),PixelFormat.Format32bppArgb)){
        used.Save(Path.Combine(output,"frames.png"),ImageFormat.Png);
      }
    }
    return samples.ToArray();
  }
}
