package cn.smartengineering.dailyreport;

import android.app.Activity;
import android.widget.Toast;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/** Native networking and Android document picker for the bundled daily-report form. */
public class MainActivity extends Activity {
  private static final String HOST="appassets.androidplatform.net";
  private static final int CHOOSE=40, SAVE=41, CAPTURE=42, SITE_SAVE=43, LIMIT=32*1024*1024;
  private WebView web;
  private FrameLayout content;
  private final ExecutorService executor=Executors.newFixedThreadPool(2);
  private ValueCallback<Uri[]> chooser;
  private int chooserRequest;
  private File captureFile;
  private Uri captureUri;
  private String saveId;
  private byte[] saveBytes;
  private final Map<String,SiteMediaProxy.Grant> siteGrants=new ConcurrentHashMap<>();
  private volatile SiteSave siteSave;
  private AppUpdater updater;
  private static final class SiteSave {
    final String id;final SiteMediaDownload.Spec spec;final SiteMediaDownload.Cancellation cancellation=new SiteMediaDownload.Cancellation();
    volatile Uri destination;
    SiteSave(String id,SiteMediaDownload.Spec spec){this.id=id;this.spec=spec;}
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    updater=new AppUpdater(this);
    content=new FrameLayout(this);web=new WebView(this);
    content.addView(web,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.MATCH_PARENT));setContentView(content);
    if(android.os.Build.VERSION.SDK_INT>=35){
      getWindow().setDecorFitsSystemWindows(false);
      styleSystemBars();
      content.setOnApplyWindowInsetsListener((view,insets)->{Insets safe=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()|WindowInsets.Type.ime());view.setPadding(safe.left,safe.top,safe.right,safe.bottom);return WindowInsets.CONSUMED;});
      content.requestApplyInsets();
    }
    web.getSettings().setJavaScriptEnabled(true);web.getSettings().setDomStorageEnabled(true);
    web.getSettings().setTextZoom(Math.round(getResources().getConfiguration().fontScale*100));
    web.getSettings().setAllowFileAccess(false);web.getSettings().setAllowContentAccess(true);
    web.getSettings().setAllowFileAccessFromFileURLs(false);web.getSettings().setAllowUniversalAccessFromFileURLs(false);
    web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.getSettings().setGeolocationEnabled(false);WebView.setWebContentsDebuggingEnabled(false);
    web.addJavascriptInterface(new Bridge(),"AndroidDailyReport");
    web.setWebViewClient(new WebViewClient(){
      @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request) {
        Uri uri=request.getUrl();String path=uri.getPath();
        if("https".equals(uri.getScheme())&&HOST.equals(uri.getHost())&&path!=null&&path.startsWith("/api/engineering-site-media/")){
          try{SiteMediaProxy.Response proxy=SiteMediaProxy.open(siteGrants.get(path),uri.toString(),request.getMethod(),request.getRequestHeaders(),android.os.SystemClock.elapsedRealtime());return new WebResourceResponse(proxy.mime,null,proxy.status,proxy.reason,proxy.headers,proxy.stream);}catch(Exception ignored){return new WebResourceResponse("text/plain","utf-8",503,"Service Unavailable",new HashMap<>(),new ByteArrayInputStream(new byte[0]));}
        }
        if(!"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost()) || path==null || !path.startsWith("/www/") || path.contains(".."))return denied();
        try {
          String type=path.endsWith(".html")?"text/html":path.endsWith(".js")?"text/javascript":path.endsWith(".css")?"text/css":path.endsWith(".svg")?"image/svg+xml":"application/octet-stream";
          Map<String,String> headers=new HashMap<>();headers.put("X-Content-Type-Options","nosniff");headers.put("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; base-uri 'none'; frame-src 'none'; connect-src 'none'");
          return new WebResourceResponse(type,"utf-8",200,"OK",headers,getAssets().open(path.substring(1)));
        }catch(Exception e){return denied();}
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
        Uri uri=request.getUrl();if("https".equals(uri.getScheme())&&HOST.equals(uri.getHost()))return false;
        if(request.isForMainFrame() && "https".equals(uri.getScheme()) && "open-meteo.com".equals(uri.getHost()))try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception ignored){}
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient(){
      @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
        // Keep one system picker active so a late result cannot be delivered to a newer request.
        if(chooser!=null){callback.onReceiveValue(null);return true;}chooser=callback;
        if(params.isCaptureEnabled()){
          try {
            captureFile=CameraCaptureFiles.create(getCacheDir());captureUri=Uri.parse("content://"+getPackageName()+".photos/captures/"+captureFile.getName());
            Intent camera=new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).putExtra(android.provider.MediaStore.EXTRA_OUTPUT,captureUri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);
            camera.setClipData(android.content.ClipData.newRawUri("现场拍照",captureUri));chooserRequest=CAPTURE;startActivityForResult(camera,CAPTURE);
          }catch(Exception e){finishChooser(null,true);}return true;
        }
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);
        String[] accept=DocumentAcceptTypes.resolve(params.getAcceptTypes());
        intent.setType(accept.length==1?accept[0]:"*/*");if(accept.length>1)intent.putExtra(Intent.EXTRA_MIME_TYPES,accept);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
        try{chooserRequest=CHOOSE;startActivityForResult(intent,CHOOSE);}catch(Exception e){finishChooser(null,true);}return true;
      }
    });
    web.loadUrl("https://"+HOST+"/www/mobile.html");
  }
  private WebResourceResponse denied(){return new WebResourceResponse("text/plain","utf-8",403,"Blocked",new HashMap<>(),new ByteArrayInputStream(new byte[0]));}
  private boolean local(){return web!=null && web.getUrl()!=null && web.getUrl().startsWith("https://"+HOST+"/www/");}
  private void result(String id,JSONObject payload){runOnUiThread(()->{if(!isFinishing()&&local())web.evaluateJavascript("window.__dailyResult("+JSONObject.quote(id)+","+JSONObject.quote(payload.toString())+")",null);});}
  private void error(String id,String message){JSONObject object=new JSONObject();try{object.put("error",message);}catch(Exception ignored){}result(id,object);}
  private void finishChooser(Uri[] uris,boolean discardCapture) {
    ValueCallback<Uri[]> callback=chooser;File file=captureFile;Uri uri=captureUri;
    chooser=null;chooserRequest=0;captureFile=null;captureUri=null;
    if(uri!=null)try{revokeUriPermission(uri,Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}
    if(discardCapture)CameraCaptureFiles.discard(file);
    // Revoke the external camera grant, but retain successful output for the app's WebView to read.
    if(callback!=null)callback.onReceiveValue(uris);
  }

  private class Bridge {
    @JavascriptInterface public void checkUpdate(String id,String baseUrl) {
      if(id==null || !id.matches("[a-zA-Z0-9_-]{1,60}"))return;
      runOnUiThread(()->{if(!local())return;executor.execute(()->{try{result(id,updater.check(baseUrl));}catch(java.io.IOException e){error(id,"无法检查更新，请检查网络后重试");}catch(Exception e){error(id,e.getMessage()==null?"更新检查失败，请重试":e.getMessage());}});});
    }
    @JavascriptInterface public void installUpdate(String id,String baseUrl) {
      if(id==null || !id.matches("[a-zA-Z0-9_-]{1,60}"))return;
      runOnUiThread(()->{if(!local())return;try{result(id,updater.install(baseUrl));}catch(Exception e){error(id,e.getMessage());}});
    }
    @JavascriptInterface public void request(String id,String encoded) {
      if(id==null || !id.matches("[a-zA-Z0-9_-]{1,60}") || encoded==null || encoded.length()>44*1024*1024)return;
      runOnUiThread(()->{if(!local()){error(id,"页面来源无效");return;}executor.execute(()->network(id,encoded));});
    }
    @JavascriptInterface public void saveFile(String id,String name,String mime,String data) {
      if(id==null || !id.matches("[a-zA-Z0-9_-]{1,60}"))return;
      runOnUiThread(()->{
        if(!local() || saveId!=null || siteSave!=null){error(id,"请先完成当前文件保存");return;}
        try {
          if(data==null || data.length()>44*1024*1024 || name==null || name.contains("/") || name.contains("\\") || name.length()>160)throw new Exception();
          boolean json=name.endsWith(".json"),docx=name.endsWith(".docx"),xlsx=name.endsWith(".xlsx"),image=name.endsWith(".png")||name.endsWith(".jpg")||name.endsWith(".jpeg");if(!json && !docx && !xlsx && !image)throw new Exception();
          saveBytes=Base64.decode(data,Base64.DEFAULT);if(saveBytes.length>LIMIT)throw new Exception();saveId=id;
          Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(json?"application/json":xlsx?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":image?(name.endsWith(".png")?"image/png":"image/jpeg"):"application/vnd.openxmlformats-officedocument.wordprocessingml.document");
          intent.putExtra(Intent.EXTRA_TITLE,name);startActivityForResult(intent,SAVE);
        }catch(Exception e){saveId=null;saveBytes=null;error(id,"无法打开文件保存窗口");}
      });
    }
    @JavascriptInterface public void downloadSiteFile(String id,String encoded) {
      if(id==null||!id.matches("[a-zA-Z0-9_-]{1,60}")||encoded==null||encoded.length()>16000)return;
      runOnUiThread(()->{
        if(!local()){error(id,"页面来源无效");return;}
        if(saveId!=null||siteSave!=null){error(id,"请先完成当前文件保存");return;}
        try {
          JSONObject config=new JSONObject(encoded);
          SiteMediaDownload.Spec spec=new SiteMediaDownload.Spec(config.getString("baseUrl"),config.getString("path"),config.getString("token"),config.getString("name"),config.getString("mime"),config.getLong("bytes"),config.getString("sha256"));
          SiteMediaProxy.Grant grant=siteGrants.get(spec.path);
          if(!SiteMediaProxy.sameOriginal(spec,grant,android.os.SystemClock.elapsedRealtime()))throw new SiteMediaDownload.Failure("下载授权或原件信息已更新，请重新打开资料");
          siteSave=new SiteSave(id,spec);
          Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(spec.mime).putExtra(Intent.EXTRA_TITLE,spec.name);
          startActivityForResult(intent,SITE_SAVE);
        }catch(Exception e){siteSave=null;error(id,e instanceof SiteMediaDownload.Failure?e.getMessage():"无法打开文件保存窗口，请重试");}
      });
    }
    @JavascriptInterface public void cancelSiteFile(String id) {
      if(id==null||!id.matches("[a-zA-Z0-9_-]{1,60}"))return;
      runOnUiThread(()->{if(!local())return;SiteSave pending=siteSave;if(pending!=null&&pending.id.equals(id)){pending.cancellation.cancel();if(pending.destination==null)try{finishActivity(SITE_SAVE);}catch(Exception ignored){}}});
    }
  }
  private void rememberSiteGrant(URI base,String route,String method,String token,int status,byte[] bytes,long responseDate,long requestStarted) throws Exception {
    if(status==401||status==200&&route.equals("/api/mobile/logout")){siteGrants.clear();SiteSave pending=siteSave;if(pending!=null)pending.cancellation.cancel();}
    if(status!=200||token.isEmpty()||!SiteGrantExpiry.isGrantRoute(method,route))return;
    JSONObject grant=new JSONObject(new String(bytes,StandardCharsets.UTF_8));String path=SiteMediaDownload.grantPath(grant.getString("url"));long now=android.os.SystemClock.elapsedRealtime(),expiresAt;
    try{expiresAt=SiteGrantExpiry.deadline(grant.getLong("expiresAt"),responseDate,requestStarted,now);}catch(IllegalArgumentException|ArithmeticException invalid){throw new SiteMediaDownload.Failure("预览或下载授权时间无效，请重新打开资料后重试");}
    SiteMediaDownload.Spec original=new SiteMediaDownload.Spec(base.toString(),path,token,grant.getString("name"),grant.getString("mime"),grant.getLong("byteCount"),grant.getString("sha256"));
    if(SiteGrantExpiry.isPackageRoute(method,route)!=original.packaged())throw new SiteMediaDownload.Failure("资料下载授权类型不符，请重新打开资料");
    for(Map.Entry<String,SiteMediaProxy.Grant> entry:siteGrants.entrySet())if(entry.getValue().expiresAt<=now)siteGrants.remove(entry.getKey(),entry.getValue());
    if(siteGrants.size()>=64)siteGrants.clear();
    siteGrants.put(path,new SiteMediaProxy.Grant(original,expiresAt));
  }
  private void discardSiteOutput(Uri uri) {
    if(uri==null)return;
    try{if(android.provider.DocumentsContract.deleteDocument(getContentResolver(),uri))return;}catch(Exception ignored){}
    // Some providers disallow deletion. Truncation ensures a failed file is not mistaken for a valid original.
    try(OutputStream output=getContentResolver().openOutputStream(uri,"wt")){if(output!=null)output.flush();}catch(Exception ignored){}
  }
  private void saveSiteOriginal(SiteSave pending) {
    File temporary=null;boolean saved=false;
    try {
      pending.cancellation.check();temporary=File.createTempFile("site-original-",".part",getCacheDir());SiteMediaDownload.Result verified;
      try(FileOutputStream output=new FileOutputStream(temporary)){verified=SiteMediaDownload.transfer(pending.spec,output,pending.cancellation);output.getFD().sync();}
      pending.cancellation.check();
      try(InputStream input=new FileInputStream(temporary);OutputStream output=getContentResolver().openOutputStream(pending.destination,"wt")){
        if(output==null)throw new Exception();byte[] block=new byte[16384];int count;while((count=input.read(block))!=-1){pending.cancellation.check();output.write(block,0,count);}output.flush();
      }
      pending.cancellation.check();saved=true;result(pending.id,new JSONObject().put("saved",true).put("bytes",verified.bytes).put("sha256",verified.sha256));
    }catch(Exception e){
      if(pending.cancellation.cancelled()){JSONObject cancelled=new JSONObject();try{cancelled.put("cancelled",true);}catch(Exception ignored){}result(pending.id,cancelled);}
      else error(pending.id,e instanceof SiteMediaDownload.Failure?e.getMessage():"原文件保存失败，请检查手机空间和网络后重试");
    }finally{if(!saved)discardSiteOutput(pending.destination);if(temporary!=null)temporary.delete();if(siteSave==pending)siteSave=null;}
  }
  private void network(String id,String encoded) {
    HttpURLConnection connection=null;
    long requestStarted=android.os.SystemClock.elapsedRealtime();
    try {
      JSONObject config=new JSONObject(encoded);URI base=new URI(config.getString("baseUrl"));String path=config.getString("path"),method=config.getString("method");
      if(!("https".equals(base.getScheme()) || "http".equals(base.getScheme())) || base.getHost()==null || base.getUserInfo()!=null || base.getQuery()!=null || base.getFragment()!=null || !(base.getPath()==null || base.getPath().isEmpty() || base.getPath().equals("/")))throw new Exception();
      URI relative=new URI(path);String route=relative.getPath();
      boolean siteLibrary=route.equals("/api/mobile/engineering/site-library")||route.matches("/api/mobile/engineering/projects/[0-9a-fA-F-]{36}/site-library(?:/packages)?")||route.equals("/api/mobile/engineering/site-library/packages");
      boolean projectScope=route.matches("/api/mobile/engineering/projects/[0-9a-fA-F-]{36}/wbs/project-scope");
      if((siteLibrary||projectScope)&&(!route.equals(relative.getRawPath())||(SiteGrantExpiry.isPackageRoute(method,route)||projectScope)&&relative.getQuery()!=null))throw new Exception();
      boolean reports=route.matches("/api/mobile/daily-report/submissions(?:/[0-9a-fA-F-]{36}(?:/(?:word|data|photos/(?:[0-9]|1[01])))?)?");
      boolean archives=route.matches("/api/mobile/photo-archives(?:/template|/[0-9a-fA-F-]{36}(?:/photos(?:/[0-9a-fA-F-]{36})?|/exports(?:/[0-9a-fA-F-]{36}/word)?)?)?");
      boolean get=method.equals("GET") && (reports || archives || route.equals("/api/mobile/me") || route.equals("/api/mobile/daily-report/template") || route.equals("/api/mobile/daily-report/weather"));
      boolean post=method.equals("POST") && (route.equals("/api/mobile/photo-archives") || route.matches("/api/mobile/photo-archives/[0-9a-fA-F-]{36}/(?:photos|exports)") || route.equals("/api/mobile/daily-report/submissions") || route.equals("/api/mobile/login") || route.equals("/api/mobile/logout") || route.equals("/api/mobile/password") || route.equals("/api/mobile/daily-report/export"));
      boolean modify=method.equals("PUT") && route.matches("/api/mobile/photo-archives/[0-9a-fA-F-]{36}") || method.equals("DELETE") && route.matches("/api/mobile/photo-archives/[0-9a-fA-F-]{36}/photos/[0-9a-fA-F-]{36}");
      boolean engineering=EngineeringRoutes.allows(method,route);
      if(engineering){get=method.equals("GET");post=method.equals("POST");modify=method.equals("PUT");}
      if(!get && !post && !modify || relative.getHost()!=null || relative.getFragment()!=null || relative.getScheme()!=null)throw new Exception();
      URL url=base.resolve(relative).toURL();connection=(HttpURLConnection)url.openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(12000);connection.setReadTimeout(SiteGrantExpiry.isPackageRoute(method,route)?130000:60000);connection.setRequestMethod(method);
      connection.setRequestProperty("Content-Type","application/json");connection.setRequestProperty("X-Workspace-Request","1");
      String token=config.optString("token");if(!token.isEmpty()){if(!token.matches("[A-Za-z0-9_-]{43}"))throw new Exception();connection.setRequestProperty("Authorization","Bearer "+token);}
      if(post||modify){byte[] body=config.optString("body").getBytes(StandardCharsets.UTF_8);if(body.length>30*1024*1024)throw new Exception();connection.setDoOutput(true);connection.setFixedLengthStreamingMode(body.length);try(OutputStream out=connection.getOutputStream()){out.write(body);}}
      int status=connection.getResponseCode();InputStream stream=status>=400?connection.getErrorStream():connection.getInputStream();ByteArrayOutputStream bytes=new ByteArrayOutputStream();
      if(stream!=null)try(InputStream input=stream){byte[] block=new byte[16384];int count;while((count=input.read(block))!=-1){if(bytes.size()+count>LIMIT)throw new Exception();bytes.write(block,0,count);}}
      byte[] responseBytes=bytes.toByteArray();rememberSiteGrant(base,route,method,token,status,responseBytes,connection.getDate(),requestStarted);
      JSONObject payload=new JSONObject().put("status",status).put("contentType",connection.getContentType()).put("base64",Base64.encodeToString(responseBytes,Base64.NO_WRAP));result(id,payload);
    }catch(Exception e){error(id,e instanceof SiteMediaDownload.Failure?e.getMessage():"连接失败，填写内容已保留，请检查网络后重试");}finally{if(connection!=null)connection.disconnect();}
  }
  @Override protected void onActivityResult(int code,int status,Intent intent) {
    super.onActivityResult(code,status,intent);
    if(code==CAPTURE && chooserRequest==CAPTURE && chooser!=null){boolean captured=status==RESULT_OK&&captureUri!=null&&CameraCaptureFiles.hasOutput(captureFile);if(status==RESULT_OK&&!captured)Toast.makeText(this,"未取得本次拍摄的原图，请重新拍照",Toast.LENGTH_LONG).show();finishChooser(captured?new Uri[]{captureUri}:null,!captured);}
    if(code==CHOOSE && chooserRequest==CHOOSE && chooser!=null){Uri[] uris=null;if(status==RESULT_OK && intent!=null){if(intent.getClipData()!=null){int count=intent.getClipData().getItemCount();if(count<=100){uris=new Uri[count];for(int i=0;i<count;i++)uris[i]=intent.getClipData().getItemAt(i).getUri();}else Toast.makeText(this,"一次最多选择100个原件，请分批上传",Toast.LENGTH_LONG).show();}else if(intent.getData()!=null)uris=new Uri[]{intent.getData()};}if(uris!=null)for(Uri uri:uris)if(!"content".equals(uri.getScheme())){uris=null;break;}finishChooser(uris,false);}
    if(code==SAVE && saveId!=null){String id=saveId;byte[] bytes=saveBytes;saveId=null;saveBytes=null;if(status!=RESULT_OK || intent==null || intent.getData()==null){JSONObject cancelled=new JSONObject();try{cancelled.put("cancelled",true);}catch(Exception ignored){}result(id,cancelled);return;}Uri uri=intent.getData();executor.execute(()->NativeFileSave.save(bytes,new NativeFileSave.Destination(){public OutputStream open()throws java.io.IOException{return getContentResolver().openOutputStream(uri,"wt");}public void discard(){discardSiteOutput(uri);}},new NativeFileSave.Completion(){public void saved(){JSONObject saved=new JSONObject();try{saved.put("saved",true);}catch(Exception ignored){}result(id,saved);}public void failed(){error(id,"保存文件失败，请检查手机空间后重试");}}));}
    if(code==SITE_SAVE&&siteSave!=null){SiteSave pending=siteSave;if(status!=RESULT_OK||intent==null||intent.getData()==null||!"content".equals(intent.getData().getScheme())){siteSave=null;JSONObject cancelled=new JSONObject();try{cancelled.put("cancelled",true);}catch(Exception ignored){}result(pending.id,cancelled);return;}pending.destination=intent.getData();executor.execute(()->saveSiteOriginal(pending));}
  }
  @Override public void onConfigurationChanged(Configuration configuration){super.onConfigurationChanged(configuration);if(web!=null){web.invalidate();content.requestApplyInsets();styleSystemBars();}}
  private void styleSystemBars(){if(android.os.Build.VERSION.SDK_INT>=35){boolean night=(getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES;content.setBackgroundColor(getResources().getColor(night?R.color.app_system_bar:R.color.app_surface,getTheme()));getWindow().setNavigationBarContrastEnforced(false);android.view.WindowInsetsController controller=getWindow().getInsetsController();if(controller!=null){int mask=android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;controller.setSystemBarsAppearance(night?0:mask,mask);}}}
  @Override public void onWindowFocusChanged(boolean focused){super.onWindowFocusChanged(focused);if(focused)styleSystemBars();}
  @Override protected void onResume(){super.onResume();if(updater!=null)updater.resume();getWindow().getDecorView().post(this::styleSystemBars);}
  @Override protected void onDestroy(){finishChooser(null,true);SiteSave pending=siteSave;if(pending!=null)pending.cancellation.cancel();siteGrants.clear();executor.shutdownNow();if(web!=null){web.removeJavascriptInterface("AndroidDailyReport");web.destroy();web=null;}super.onDestroy();}
}
