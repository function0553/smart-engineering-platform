package cn.smartengineering.dailyreport;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.io.File;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONObject;

/** Server version check and automatic verified download. Installation uses Android's confirmation UI. */
final class AppUpdater {
  private final Activity activity; private JSONObject ready; private String readyOrigin;
  private final File apk; private boolean awaitingPermission;
  AppUpdater(Activity activity){this.activity=activity;apk=new File(activity.getCacheDir(),"updates/verified.apk");}
  private PackageInfo installed() throws Exception{return activity.getPackageManager().getPackageInfo(activity.getPackageName(),signingFlags());}
  private int signingFlags(){return Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;}
  private long version(PackageInfo info){return Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode;}
  private Signature[] signatures(PackageInfo info){return Build.VERSION.SDK_INT>=28?info.signingInfo.getApkContentsSigners():info.signatures;}
  private URI base(String address) throws Exception {
    URI base=new URI(address);
    boolean development="http".equals(base.getScheme()) && Arrays.asList("127.0.0.1","localhost","10.0.2.2").contains(base.getHost());
    if(!(development||"https".equals(base.getScheme())) || base.getHost()==null || base.getUserInfo()!=null || base.getQuery()!=null || base.getFragment()!=null || !(base.getPath()==null||base.getPath().isEmpty()||base.getPath().equals("/")))throw new Exception("更新地址必须使用 HTTPS");
    return base;
  }
  private HttpURLConnection open(URI base,String path) throws Exception {
    HttpURLConnection connection=(HttpURLConnection)base.resolve(path).toURL().openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(12000);connection.setReadTimeout(60000);
    if(connection.getResponseCode()!=200){connection.disconnect();throw new Exception("服务器更新检查失败");}return connection;
  }
  synchronized JSONObject check(String address) throws Exception {
    URI origin=base(address);PackageInfo current=installed();HttpURLConnection connection=open(origin,"/api/mobile/app-update?versionCode="+version(current));JSONObject manifest;
    try(InputStream input=connection.getInputStream();ByteArrayOutputStream bytes=new ByteArrayOutputStream()){byte[] block=new byte[4096];int count;while((count=input.read(block))!=-1){if(bytes.size()+count>16000)throw new Exception("更新信息无效");bytes.write(block,0,count);}manifest=new JSONObject(bytes.toString("UTF-8"));}finally{connection.disconnect();}
    JSONObject result=new JSONObject().put("currentVersion",current.versionName).put("currentCode",version(current));
    if(!manifest.optBoolean("available")||manifest.optLong("versionCode")<=version(current)){ready=null;readyOrigin=null;apk.delete();return result.put("available",false);}
    if(!activity.getPackageName().equals(manifest.optString("package")) || manifest.optInt("minAndroidApi")>Build.VERSION.SDK_INT || !manifest.optString("sha256").matches("[0-9a-f]{64}") || manifest.optLong("size")<1 || manifest.optLong("size")>16*1024*1024 || !"/api/mobile/app-update/apk".equals(manifest.optString("downloadPath")))throw new Exception("更新信息无效或不兼容此手机");
    if(ready==null || !origin.toString().equals(readyOrigin) || !manifest.getString("sha256").equals(ready.optString("sha256")) || !apk.isFile()){
      ready=null;readyOrigin=null;File directory=apk.getParentFile();directory.mkdirs();File temporary=new File(directory,"download.part");temporary.delete();
      connection=open(origin,"/api/mobile/app-update/apk");MessageDigest digest=MessageDigest.getInstance("SHA-256");long size=0;
      try(InputStream input=connection.getInputStream();FileOutputStream output=new FileOutputStream(temporary)){
        byte[] block=new byte[16384];int count;while((count=input.read(block))!=-1){size+=count;if(size>manifest.getLong("size"))throw new Exception("更新包大小校验失败");digest.update(block,0,count);output.write(block,0,count);}output.getFD().sync();
        StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format("%02x",b&255));
        if(size!=manifest.getLong("size")||!hex.toString().equals(manifest.getString("sha256")))throw new Exception("更新包校验失败，请重试");
        verify(temporary,current,manifest);apk.delete();if(!temporary.renameTo(apk))throw new Exception("更新包保存失败");
        ready=manifest;readyOrigin=origin.toString();
      }finally{connection.disconnect();temporary.delete();}
    } else {try{verify(apk,current,manifest);}catch(Exception e){ready=null;readyOrigin=null;apk.delete();return check(address);}}
    return result.put("available",true).put("ready",true).put("versionName",manifest.getString("versionName")).put("notes",manifest.optJSONArray("notes"));
  }
  private void verify(File file,PackageInfo current,JSONObject manifest) throws Exception {
    MessageDigest digest=MessageDigest.getInstance("SHA-256");long size=0;
    try(InputStream input=new java.io.FileInputStream(file)){byte[] buffer=new byte[16384];int count;while((count=input.read(buffer))!=-1){size+=count;digest.update(buffer,0,count);}}
    StringBuilder checksum=new StringBuilder();for(byte b:digest.digest())checksum.append(String.format("%02x",b&255));
    if(size!=manifest.getLong("size") || !checksum.toString().equals(manifest.getString("sha256")))throw new Exception("更新包校验失败，请重新检查下载");
    PackageInfo candidate=activity.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(),signingFlags());
    if(candidate==null || !activity.getPackageName().equals(candidate.packageName) || version(candidate)!=manifest.getLong("versionCode") || version(candidate)<=version(current))throw new Exception("安装包版本或应用标识校验失败");
    Signature[] existing=signatures(current),incoming=signatures(candidate);if(existing==null||incoming==null||existing.length!=incoming.length)throw new Exception("更新包签名不匹配");
    for(Signature signature:existing){boolean found=false;for(Signature other:incoming)if(signature.equals(other))found=true;if(!found)throw new Exception("更新包签名不匹配，已停止安装");}
  }
  synchronized JSONObject install(String address) throws Exception {
    if(ready==null || !base(address).toString().equals(readyOrigin) || !apk.isFile())throw new Exception("请先检查并下载更新");
    verify(apk,installed(),ready);
    if(!activity.getPackageManager().canRequestPackageInstalls()){
      awaitingPermission=true;activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.getPackageName())));return new JSONObject().put("permissionRequired",true);
    }
    awaitingPermission=false;Uri uri=Uri.parse("content://"+activity.getPackageName()+".updates/verified.apk");
    activity.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
    return new JSONObject().put("installerOpened",true);
  }
  void resume(){if(awaitingPermission && activity.getPackageManager().canRequestPackageInstalls())try{install(readyOrigin);}catch(Exception ignored){} }
}
