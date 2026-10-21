"""Host-test actual native result branches; compile all Java and D8 for min API 26. No device or signing."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'outputs/site-library-native-20261021'
JAVA=Path(os.environ.get('REPORT_JAVA_HOME','/Users/chaofan/Documents/CodexMigration/runtime/java21/jdk-21.0.12.1+1/Contents/Home'))
PLATFORM=Path(os.environ.get('REPORT_ANDROID_PLATFORM','/Users/chaofan/Documents/CodexMigration/runtime/android-sdk-mac/platforms/android-35/android.jar'))
TOOLS=Path(os.environ.get('REPORT_ANDROID_TOOLS','/Users/chaofan/Documents/CodexMigration/runtime/android-sdk-mac/build-tools/35.0.0'))
NATIVE=ROOT/'android/src/cn/smartengineering/dailyreport'
for folder in ['classes','dex','generated','host-src','host-classes']:
    if (OUT/folder).exists():shutil.rmtree(OUT/folder)
for folder in ['classes','dex','generated/cn/smartengineering/dailyreport','host-src','host-classes']:(OUT/folder).mkdir(parents=True,exist_ok=True)

def run(args,label):
    result=subprocess.run(list(map(str,args)),cwd=ROOT,capture_output=True,text=True)
    (OUT/(label+'.log')).write_text(result.stdout+result.stderr)
    if result.returncode:raise RuntimeError(label+' failed: '+(result.stdout+result.stderr)[-5000:])
    return result.stdout

# Only compile-time identifiers; the root build still owns resources, packaging and signing.
r=OUT/'generated/cn/smartengineering/dailyreport/R.java'
r.write_text('package cn.smartengineering.dailyreport; final class R {static final class color {static final int app_system_bar=1,app_surface=2;}static final class raw {static final int server252_ca=3;}}')
sources=sorted(NATIVE.glob('*.java'))
run([JAVA/'bin/javac','-encoding','UTF-8','--release','8','-classpath',PLATFORM,'-d',OUT/'classes',*sources,r],'android-java-compile')
run([JAVA/'bin/jar','cf',OUT/'classes.jar','-C',OUT/'classes','.'],'android-java-jar')
run([JAVA/'bin/java','-cp',TOOLS/'lib/d8.jar','com.android.tools.r8.D8','--release','--min-api','26','--lib',PLATFORM,'--output',OUT/'dex',OUT/'classes.jar'],'android-api26-d8')

# Small host stand-ins for framework side effects, not replacements for the production result methods.
# The harness loads the actual compiled MainActivity, PhotoProvider and both production helpers above.
stubs={
'android/content/Context.java':'''package android.content; import java.io.File; public class Context {public File getCacheDir(){return null;}public String getPackageName(){return "cn.smartengineering.dailyreport";}public ContentResolver getContentResolver(){return null;}}''',
'android/app/Activity.java':'''package android.app; import android.content.*;import android.net.Uri; public class Activity extends Context {public static final int RESULT_OK=-1;public int revoked;protected void onActivityResult(int code,int status,Intent intent){}public void runOnUiThread(Runnable action){action.run();}public boolean isFinishing(){return false;}public void revokeUriPermission(Uri uri,int flags){revoked++;}}''',
'android/view/View.java':'''package android.view; public class View {}''',
'android/webkit/WebView.java':'''package android.webkit; public class WebView extends android.view.View {public final java.util.List<String> callbacks=new java.util.concurrent.CopyOnWriteArrayList<>();public String getUrl(){return "https://appassets.androidplatform.net/www/mobile.html";}public void evaluateJavascript(String script,ValueCallback<String> callback){callbacks.add(script);}}''',
'android/net/Uri.java':'''package android.net; public class Uri {private final java.net.URI value;private Uri(String text){value=java.net.URI.create(text);}public static Uri parse(String text){return new Uri(text);}public String getPath(){return value.getPath();}public String getAuthority(){return value.getAuthority();}public String getScheme(){return value.getScheme();}public String toString(){return value.toString();}}''',
'android/content/Intent.java':'''package android.content; import android.net.Uri;public class Intent {private Uri data;private ClipData clip;public Intent(){}public Intent setData(Uri value){data=value;return this;}public Uri getData(){return data;}public Intent setClipData(ClipData value){clip=value;return this;}public ClipData getClipData(){return clip;}}''',
'android/content/ClipData.java':'''package android.content;import android.net.Uri;public class ClipData{private final Uri[] values;public ClipData(Uri... value){values=value;}public int getItemCount(){return values.length;}public Item getItemAt(int i){return new Item(values[i]);}public static class Item{private final Uri value;Item(Uri v){value=v;}public Uri getUri(){return value;}}}''',
'android/content/ContentResolver.java':'''package android.content;import java.io.*;import android.net.Uri;public abstract class ContentResolver{public abstract OutputStream openOutputStream(Uri uri,String mode)throws FileNotFoundException;public boolean delete(Uri uri){return false;}}''',
'android/provider/DocumentsContract.java':'''package android.provider;import android.content.ContentResolver;import android.net.Uri;public final class DocumentsContract{public static boolean deleteDocument(ContentResolver resolver,Uri uri){return resolver.delete(uri);}}''',
'android/widget/Toast.java':'''package android.widget;import android.content.Context;public class Toast{public static final int LENGTH_LONG=1;public static Toast makeText(Context context,CharSequence text,int duration){return new Toast();}public void show(){}}''',
'android/content/ContentProvider.java':'''package android.content;import android.database.Cursor;import android.net.Uri;import android.os.ParcelFileDescriptor;import java.io.FileNotFoundException;public abstract class ContentProvider{private Context context;public void attach(Context value){context=value;}public Context getContext(){return context;}public abstract boolean onCreate();public abstract String getType(Uri uri);public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{return null;}public abstract Cursor query(Uri uri,String[] p,String s,String[] a,String o);public abstract Uri insert(Uri uri,ContentValues value);public abstract int update(Uri uri,ContentValues value,String w,String[] a);public abstract int delete(Uri uri,String w,String[] a);}''',
'android/util/Base64.java':'''package android.util;public class Base64{public static final int NO_WRAP=2;public static String encodeToString(byte[] data,int flags){return java.util.Base64.getEncoder().encodeToString(data);}}''',
'android/os/SystemClock.java':'''package android.os;public class SystemClock{public static long value=1000240;public static long elapsedRealtime(){return value;}}''',
'android/os/ParcelFileDescriptor.java':'''package android.os;import java.io.*;public class ParcelFileDescriptor{public static final int MODE_READ_ONLY=1;public final File file;private ParcelFileDescriptor(File value){file=value;}public static int parseMode(String mode){return MODE_READ_ONLY;}public static ParcelFileDescriptor open(File value,int mode)throws FileNotFoundException{if(!value.isFile())throw new FileNotFoundException();return new ParcelFileDescriptor(value);}}''',
'android/database/Cursor.java':'''package android.database;public interface Cursor{}''',
'android/database/MatrixCursor.java':'''package android.database;public class MatrixCursor implements Cursor{public MatrixCursor(String[] columns){}public void addRow(Object[] row){}}''',
'org/json/JSONObject.java':'''package org.json;import java.util.*;public class JSONObject{private final Map<String,Object> values=new LinkedHashMap<>();public JSONObject(){}public JSONObject(String text){java.util.regex.Matcher m=java.util.regex.Pattern.compile("\\\"([^\\\"]+)\\\"\\\\s*:\\\\s*(?:\\\"([^\\\"]*)\\\"|(-?[0-9]+))").matcher(text);while(m.find())values.put(m.group(1),m.group(2)!=null?m.group(2):Long.parseLong(m.group(3)));}public String getString(String key){return (String)values.get(key);}public String optString(String key){Object value=values.get(key);return value==null?"":value.toString();}public long getLong(String key){return ((Number)values.get(key)).longValue();}public JSONObject put(String key,long value){values.put(key,value);return this;}public JSONObject put(String key,int value){values.put(key,value);return this;}public JSONObject put(String key,Object value){values.put(key,value);return this;}public JSONObject put(String key,boolean value){values.put(key,value);return this;}public String toString(){StringBuilder result=new StringBuilder("{");for(Map.Entry<String,Object> entry:values.entrySet()){if(result.length()>1)result.append(',');result.append(quote(entry.getKey())).append(':').append(entry.getValue() instanceof String?quote((String)entry.getValue()):entry.getValue());}return result.append('}').toString();}public static String quote(String text){return "\\\""+text.replace("\\\\","\\\\\\\\").replace("\\\"","\\\\\\\"")+"\\\"";}}''',
}
for relative,text in stubs.items():
    path=OUT/'host-src'/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)

harness=OUT/'host-src/cn/smartengineering/dailyreport/NativeMediaHarness.java'
harness.parent.mkdir(parents=True,exist_ok=True)
harness.write_text(r'''package cn.smartengineering.dailyreport;
import android.content.*;import android.net.Uri;import android.webkit.*;import android.os.ParcelFileDescriptor;
import java.io.*;import java.nio.file.Files;import java.lang.reflect.*;import java.util.*;import java.util.concurrent.*;
public final class NativeMediaHarness {
  static final Uri DESTINATION=Uri.parse("content://fixture/original.docx");
  static final byte[] ORIGINAL=new byte[]{0x50,0x4b,3,4,42,0,1,2,3};
  static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
  static void field(Object object,String name,Object value)throws Exception{Field f=MainActivity.class.getDeclaredField(name);f.setAccessible(true);f.set(object,value);}
  static Object field(Object object,String name)throws Exception{Field f=MainActivity.class.getDeclaredField(name);f.setAccessible(true);return f.get(object);}
  static void finish(TestActivity activity)throws Exception{((ExecutorService)field(activity,"executor")).shutdownNow();}
  static final class Provider extends ContentResolver {
    final File file;final String failure;final List<String> events=new CopyOnWriteArrayList<>();final boolean allowDelete;int opens,discards;
    Provider(File file,String failure,boolean allowDelete){this.file=file;this.failure=failure;this.allowDelete=allowDelete;}
    @Override public OutputStream openOutputStream(Uri uri,String mode)throws FileNotFoundException {
      opens++;events.add("open");if(opens==1&&failure.equals("open"))throw new FileNotFoundException("provider open failed");
      if(opens==1&&failure.equals("null"))return null;
      final boolean first=opens==1;final FileOutputStream underlying=new FileOutputStream(file);
      return new OutputStream(){
        public void write(int value)throws IOException{underlying.write(value);if(first&&failure.equals("write"))throw new IOException("provider write failed");}
        public void write(byte[] bytes)throws IOException{if(first&&failure.equals("write")){underlying.write(bytes,0,3);throw new IOException("provider write failed");}underlying.write(bytes);events.add("write");}
        public void flush()throws IOException{underlying.flush();events.add("flush");if(first&&failure.equals("flush"))throw new IOException("provider flush failed");}
        public void close()throws IOException{underlying.close();events.add("close");if(first&&failure.equals("close"))throw new IOException("provider finalization failed");}
      };
    }
    @Override public boolean delete(Uri uri){discards++;events.add("discard");if(allowDelete){file.delete();return true;}return false;}
  }
  static final class TestActivity extends MainActivity {
    final File cache;final Provider provider;TestActivity(File cache,Provider provider){this.cache=cache;this.provider=provider;}
    @Override public File getCacheDir(){return cache;}
    @Override public ContentResolver getContentResolver(){return provider;}
    void respond(int code,int status,Intent intent){onActivityResult(code,status,intent);}
  }
  static void await(WebView web)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(web.callbacks.isEmpty()&&System.nanoTime()<end)Thread.sleep(2);check(web.callbacks.size()==1,"one terminal callback required: "+web.callbacks);}
  static void saveCase(File cache,String fail,boolean delete)throws Exception {
    File output=new File(cache,"save-"+fail+"-"+delete);Provider provider=new Provider(output,fail,delete);TestActivity activity=new TestActivity(cache,provider);WebView web=new WebView();
    field(activity,"web",web);field(activity,"saveId","save-"+fail);field(activity,"saveBytes",ORIGINAL);
    try {
      activity.respond(41,-1,new Intent().setData(DESTINATION));await(web);
      String callback=web.callbacks.get(0);check(field(activity,"saveId")==null&&field(activity,"saveBytes")==null,"native pending save cleared");
      if(fail.isEmpty()){
        check(callback.contains("saved")&&!callback.contains("error"),"success callback");check(provider.events.equals(Arrays.asList("open","write","flush","close")),"provider must close before success");check(Arrays.equals(ORIGINAL,Files.readAllBytes(output.toPath())),"original bytes unchanged");check(provider.discards==0,"success must not delete");
      }else{
        check(callback.contains("error")&&!callback.contains("saved"),"failure must never return saved=true: "+callback);check(provider.discards==1,"failed output cleanup once");check(!output.exists()||output.length()==0,"no partial output remains");
      }
      activity.respond(41,-1,new Intent().setData(DESTINATION));Thread.sleep(30);check(web.callbacks.size()==1,"duplicate Android result must not call again");
    }finally{finish(activity);}
  }
  static Uri captureUri(File file){return Uri.parse("content://cn.smartengineering.dailyreport.photos/captures/"+file.getName());}
  static void pending(TestActivity activity,File file,List<Uri[]> callbacks)throws Exception{field(activity,"captureFile",file);field(activity,"captureUri",captureUri(file));field(activity,"chooserRequest",42);field(activity,"chooser",(ValueCallback<Uri[]>)callbacks::add);}
  static void cameraCases(File cache)throws Exception {
    File legacy=new File(cache,"capture.jpg");Files.write(legacy.toPath(),new byte[]{8,8,8});
    Provider destination=new Provider(new File(cache,"unused"),"",true);TestActivity activity=new TestActivity(cache,destination);List<Uri[]> callbacks=new ArrayList<>();
    try {
      File empty=CameraCaptureFiles.create(cache);pending(activity,empty,callbacks);activity.respond(42,-1,null);
      check(callbacks.size()==1&&callbacks.get(0)==null,"RESULT_OK without new output must not return previous image");check(!empty.exists(),"empty failed output cleaned");check(legacy.isFile()&&legacy.length()==3,"legacy file never used/deleted");check(activity.revoked==1,"camera grant revoked on empty output");
      File first=CameraCaptureFiles.create(cache);byte[] a=new byte[]{-1,-40,-1,10,20};Files.write(first.toPath(),a);pending(activity,first,callbacks);activity.respond(42,-1,null);
      check(callbacks.size()==2&&callbacks.get(1).length==1&&callbacks.get(1)[0].toString().equals(captureUri(first).toString()),"return only requested capture URI");check(Arrays.equals(a,Files.readAllBytes(first.toPath())),"successful original retained for WebView");
      activity.respond(42,-1,null);check(callbacks.size()==2,"capture result once");
      File second=CameraCaptureFiles.create(cache);byte[] b=new byte[]{-1,-40,-1,30,40};check(!first.equals(second),"independent capture files");Files.write(second.toPath(),b);pending(activity,second,callbacks);activity.respond(42,-1,null);
      check(callbacks.get(2)[0].toString().equals(captureUri(second).toString()),"second capture URI distinct");check(Arrays.equals(a,Files.readAllBytes(first.toPath()))&&Arrays.equals(b,Files.readAllBytes(second.toPath())),"consecutive capture bytes independent");
      File cancelled=CameraCaptureFiles.create(cache);Files.write(cancelled.toPath(),b);pending(activity,cancelled,callbacks);activity.respond(42,0,null);check(callbacks.get(3)==null&&!cancelled.exists(),"cancelled capture cleaned");
      File missing=CameraCaptureFiles.create(cache);missing.delete();pending(activity,missing,callbacks);activity.respond(42,-1,null);check(callbacks.get(4)==null,"missing new output rejected");
      PhotoProvider photoProvider=new PhotoProvider();photoProvider.attach(activity);
      check("image/jpeg".equals(photoProvider.getType(captureUri(first))),"successful provider URI readable");check(photoProvider.openFile(captureUri(first),"r").file.getCanonicalFile().equals(first.getCanonicalFile()),"provider resolves exact retained original");
      for(String path:new String[]{"/capture.jpg","/captures/../capture.jpg","/captures/"+first.getName()+"/more","/captures/capture-00000000-0000-0000-0000-000000000000.jpg"}){
        try{photoProvider.openFile(Uri.parse("content://cn.smartengineering.dailyreport.photos"+path),"r");throw new AssertionError("unsafe path accepted: "+path);}catch(FileNotFoundException expected){}
      }
      try{photoProvider.openFile(Uri.parse("content://wrong.photos/captures/"+first.getName()),"r");throw new AssertionError("wrong authority");}catch(FileNotFoundException expected){}
      check(activity.revoked==5,"all completed or cancelled capture grants revoked");
    }finally{finish(activity);}
  }
  static void pickerCases(File cache)throws Exception {
    TestActivity activity=new TestActivity(cache,new Provider(new File(cache,"unused-picker"),"",true));List<Uri[]> callbacks=new ArrayList<>();Uri a=Uri.parse("content://photo/1"),b=Uri.parse("content://video/2");
    try {
      field(activity,"chooserRequest",40);field(activity,"chooser",(ValueCallback<Uri[]>)callbacks::add);activity.respond(42,-1,null);check(callbacks.isEmpty(),"wrong activity result cannot complete picker");activity.respond(40,-1,new Intent().setClipData(new ClipData(a,b)));check(callbacks.size()==1&&callbacks.get(0).length==2,"multi-select photo/video content URIs retained");
      field(activity,"chooserRequest",40);field(activity,"chooser",(ValueCallback<Uri[]>)callbacks::add);activity.respond(40,-1,new Intent().setData(Uri.parse("file:///private/file.jpg")));check(callbacks.get(1)==null,"non-content picker result rejected");
      field(activity,"chooserRequest",40);field(activity,"chooser",(ValueCallback<Uri[]>)callbacks::add);activity.respond(40,0,null);check(callbacks.get(2)==null,"picker cancel callback");
    }finally{finish(activity);}
  }
  static Object pendingSite(TestActivity activity,SiteMediaDownload.Spec spec)throws Exception {
    Class<?> type=Class.forName("cn.smartengineering.dailyreport.MainActivity$SiteSave");Constructor<?> constructor=type.getDeclaredConstructor(String.class,SiteMediaDownload.Spec.class);constructor.setAccessible(true);Object pending=constructor.newInstance("site-zip",spec);Field destination=type.getDeclaredField("destination");destination.setAccessible(true);destination.set(pending,DESTINATION);field(activity,"siteSave",pending);return pending;
  }
  static void runSite(TestActivity activity,Object pending)throws Exception{Method save=MainActivity.class.getDeclaredMethod("saveSiteOriginal",pending.getClass());save.setAccessible(true);save.invoke(activity,pending);}
  static void siteCase(File cache,String base,String sha,String fail,boolean allowDelete,boolean cancel)throws Exception {
    Provider provider=new Provider(new File(cache,"zip-"+fail+"-"+allowDelete+"-"+cancel),fail,allowDelete);TestActivity activity=new TestActivity(cache,provider);WebView web=new WebView();field(activity,"web",web);
    SiteMediaDownload.Spec spec=new SiteMediaDownload.Spec(base,"/api/engineering-site-packages/"+TOKEN,TOKEN,"项目资料.zip","application/zip",ORIGINAL.length,sha);Object pending=pendingSite(activity,spec);
    try{
      if(cancel){Field cancellation=pending.getClass().getDeclaredField("cancellation");cancellation.setAccessible(true);((SiteMediaDownload.Cancellation)cancellation.get(pending)).cancel();}
      runSite(activity,pending);await(web);String callback=web.callbacks.get(0);check(field(activity,"siteSave")==null,"ZIP pending save cleared");
      if(fail.isEmpty()&&!cancel){check(callback.contains("saved")&&!callback.contains("error"),"ZIP success callback");check(provider.events.get(provider.events.size()-1).equals("close"),"ZIP provider close before success");check(Arrays.equals(ORIGINAL,Files.readAllBytes(provider.file.toPath())),"ZIP bytes unchanged");}
      else{check(!callback.contains("saved"),"ZIP failure must not return success");check(callback.contains(cancel?"cancelled":"error"),"ZIP failure/cancel terminal callback");check(provider.discards==1,"ZIP failed output cleaned once");check(!provider.file.exists()||provider.file.length()==0,"ZIP no partial output remains");}
      activity.respond(43,-1,new Intent().setData(DESTINATION));check(web.callbacks.size()==1,"late duplicate ZIP result ignored");check(cache.listFiles((dir,name)->name.startsWith("site-original-")).length==0,"ZIP temporary cache file cleaned after success/failure/cancel");
    }finally{finish(activity);}
  }
  static final String TOKEN="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  static void zipCases(File cache)throws Exception {
    final byte[] bytes=ORIGINAL;String sha=SiteMediaDownload.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));com.sun.net.httpserver.HttpServer server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
    server.createContext("/api/engineering-site-packages/"+TOKEN,exchange->{try{exchange.getResponseHeaders().add("Content-Type","application/zip");exchange.getResponseHeaders().add("X-Content-SHA256",sha);exchange.sendResponseHeaders(200,bytes.length);try(OutputStream output=exchange.getResponseBody()){output.write(bytes);}}finally{exchange.close();}});server.start();String base="http://127.0.0.1:"+server.getAddress().getPort();
    try{
      siteCase(cache,base,sha,"",true,false);for(String fail:new String[]{"open","null","write","flush","close"})siteCase(cache,base,sha,fail,true,false);siteCase(cache,base,sha,"close",false,false);siteCase(cache,base,sha,"",true,true);
      TestActivity picker=new TestActivity(cache,new Provider(new File(cache,"zip-picker"),"",true));WebView web=new WebView();field(picker,"web",web);SiteMediaDownload.Spec spec=new SiteMediaDownload.Spec(base,"/api/engineering-site-packages/"+TOKEN,TOKEN,"资料.zip","application/zip",bytes.length,sha);pendingSite(picker,spec);picker.respond(43,0,null);await(web);check(web.callbacks.get(0).contains("cancelled")&&!web.callbacks.get(0).contains("saved"),"ZIP system picker cancellation");finish(picker);
    }finally{server.stop(0);}
  }
  interface Checked {void run()throws Exception;}
  static int zipBoundaryChecks=0,zipRouteChecks=0,zipGrantChecks=0;
  static void reject(Checked operation)throws Exception{try{operation.run();}catch(Exception expected){zipBoundaryChecks++;return;}throw new AssertionError("Expected ZIP boundary rejection");}
  static void zipBoundaryCases()throws Exception{
    String base="https://example.invalid",path="/api/engineering-site-packages/"+TOKEN,media="/api/engineering-site-media/"+TOKEN,sha=String.join("",Collections.nCopies(64,"0"));
    SiteMediaDownload.Spec source=new SiteMediaDownload.Spec(base,path,TOKEN,"项目资料.zip","application/zip",SiteMediaDownload.PACKAGE_LIMIT,sha);check(source.packaged(),"bounded ZIP spec");zipBoundaryChecks++;
    for(String bad:new String[]{path+"/extra",path+"?x=1",path+"#x",path.replace("/api/","/%61pi/"),path.replace("/api/","/private/../api/"),"https://foreign.invalid"+path,"//foreign.invalid"+path,path.replace(TOKEN,TOKEN+"A")})reject(()->new SiteMediaDownload.Spec(base,bad,TOKEN,"资料.zip","application/zip",1,sha));
    for(String mime:new String[]{"application/pdf","video/mp4","application/octet-stream","application/x-zip-compressed","APPLICATION/ZIP"})reject(()->new SiteMediaDownload.Spec(base,path,TOKEN,"资料.zip",mime,1,sha));
    reject(()->new SiteMediaDownload.Spec(base,media,TOKEN,"资料.zip","application/zip",1,sha));reject(()->new SiteMediaDownload.Spec(base,path,TOKEN,"资料.zip","application/zip",SiteMediaDownload.PACKAGE_LIMIT+1,sha));
    for(long bytes:new long[]{0,-1,Long.MAX_VALUE})reject(()->new SiteMediaDownload.Spec(base,path,TOKEN,"资料.zip","application/zip",bytes,sha));
    for(String name:new String[]{"","..","../资料.zip","资料\\a.zip","a\n.zip",String.join("",Collections.nCopies(161,"a"))})reject(()->new SiteMediaDownload.Spec(base,path,TOKEN,name,"application/zip",1,sha));
    reject(()->new SiteMediaDownload.Spec(base,path,TOKEN,"资料.zip","application/zip",1,"bad"));reject(()->new SiteMediaDownload.Spec(base,path,"bad","资料.zip","application/zip",1,sha));
    for(String mime:new String[]{"application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","image/jpeg","image/png","image/webp","video/mp4","video/webm"}){long limit=mime.startsWith("video/")?SiteMediaDownload.VIDEO_LIMIT:SiteMediaDownload.DOCUMENT_LIMIT;new SiteMediaDownload.Spec(base,media,TOKEN,"原件",mime,limit,sha);zipBoundaryChecks++;reject(()->new SiteMediaDownload.Spec(base,media,TOKEN,"原件",mime,limit+1,sha));}
    check(SiteMediaDownload.grantPath("https://canonical.invalid"+path).equals(path),"ZIP path mapped to configured origin");zipBoundaryChecks++;
    for(String bad:new String[]{"https://user:pass@canonical.invalid"+path,"//canonical.invalid"+path,"file://canonical.invalid"+path,"https://canonical.invalid"+path+"?x=1","https://canonical.invalid"+path+"#x","https://canonical.invalid"+path.replace("/api/","/%61pi/")})reject(()->SiteMediaDownload.grantPath(bad));
    SiteMediaProxy.Grant grant=new SiteMediaProxy.Grant(source,2000);check(SiteMediaProxy.sameOriginal(source,grant,1000),"ZIP registered identity");zipBoundaryChecks++;
    check(!SiteMediaProxy.accepts(grant,SiteMediaProxy.WEBVIEW_ORIGIN+path,"GET",1000)&&SiteMediaProxy.open(grant,SiteMediaProxy.WEBVIEW_ORIGIN+path,"GET",Collections.emptyMap(),1000).status==403,"ZIP must not enter preview proxy");zipBoundaryChecks++;
    check(!SiteMediaProxy.sameOriginal(source,grant,2000)&&!SiteMediaDownload.authorized(source,"https://foreign.invalid/",TOKEN,2000,1000)&&!SiteMediaDownload.authorized(source,source.origin.toString(),"B"+TOKEN.substring(1),2000,1000),"ZIP session/origin/TTL binding");zipBoundaryChecks++;
  }
  static void zipRouteCases(){
    String id="12345678-1234-1234-1234-123456789abc",p="/api/mobile/engineering/projects/"+id,root="/api/mobile/engineering/site-library";
    String[][] yes={{"GET",root},{"GET",p+"/site-library"},{"POST",root+"/packages"},{"POST",p+"/site-library/packages"},{"POST",p+"/wbs/project-scope"}};
    for(String[] pair:yes){check(EngineeringRoutes.allows(pair[0],pair[1]),"ZIP supported route "+Arrays.toString(pair));zipRouteChecks++;for(String method:new String[]{"GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"})if(!method.equals(pair[0])){check(!EngineeringRoutes.allows(method,pair[1]),"ZIP method overreach");zipRouteChecks++;}for(String bad:new String[]{pair[1]+"/extra",pair[1]+"?x=1",pair[1]+"#x",pair[1].replace(id,"------------------------------------"),pair[1].replace("/api/mobile/","/api/"),pair[1].replace("site-library","site-librar%79"),"https://host.invalid"+pair[1]})if(!bad.equals(pair[1])){check(!EngineeringRoutes.allows(pair[0],bad),"ZIP path overreach "+bad);zipRouteChecks++;}}
    for(String route:new String[]{root+"/packages",p+"/site-library/packages"}){check(SiteGrantExpiry.isGrantRoute("POST",route)&&SiteGrantExpiry.isPackageRoute("POST",route),"ZIP grant route");zipRouteChecks++;for(String method:new String[]{"GET","PUT","DELETE","PATCH","HEAD"}){check(!SiteGrantExpiry.isGrantRoute(method,route),"ZIP wrong grant method");zipRouteChecks++;}for(String bad:new String[]{route+"?x=1",route+"/extra",route.replace("/api/mobile/","/api/"),"https://host"+route}){check(!SiteGrantExpiry.isGrantRoute("POST",bad),"ZIP grant route exactness");zipRouteChecks++;}}
    check(!SiteGrantExpiry.isGrantRoute("POST",p+"/wbs/project-scope"),"WBS creation cannot register a grant");zipRouteChecks++;
    for(String kind:new String[]{"files","exports"})check(SiteGrantExpiry.isGrantRoute("POST",p+"/site-records/"+id+"/"+kind+"/"+id+"/media-grants"),"existing media grant route retained");
  }
  @SuppressWarnings("unchecked") static Map<String,SiteMediaProxy.Grant> grants(TestActivity activity)throws Exception{return (Map<String,SiteMediaProxy.Grant>)field(activity,"siteGrants");}
  static void remember(TestActivity activity,String route,String method,int status,String path,String mime,long expiry,long date,long start)throws Exception{
    String json="{\"url\":\"https://canonical.invalid"+path+"\",\"expiresAt\":"+expiry+",\"name\":\"资料.zip\",\"mime\":\""+mime+"\",\"byteCount\":9,\"sha256\":\""+String.join("",Collections.nCopies(64,"0"))+"\"}";
    Method remember=MainActivity.class.getDeclaredMethod("rememberSiteGrant",java.net.URI.class,String.class,String.class,String.class,int.class,byte[].class,long.class,long.class);remember.setAccessible(true);
    try{remember.invoke(activity,new java.net.URI("https://example.invalid/"),route,method,TOKEN,status,json.getBytes(java.nio.charset.StandardCharsets.UTF_8),date,start);}catch(InvocationTargetException e){throw (Exception)e.getCause();}
  }
  static void zipGrantCases(File cache)throws Exception{
    TestActivity activity=new TestActivity(cache,new Provider(new File(cache,"grant-unused"),"",true));String id="12345678-1234-1234-1234-123456789abc",root="/api/mobile/engineering/site-library/packages",project="/api/mobile/engineering/projects/"+id+"/site-library/packages",mediaRoute="/api/mobile/engineering/projects/"+id+"/site-records/"+id+"/files/"+id+"/media-grants",path="/api/engineering-site-packages/"+TOKEN;long epoch=1792500000000L;
    try{
      for(String route:new String[]{root,project})for(long skew:new long[]{-86400000,0,86400000}){
        android.os.SystemClock.value=1000240;remember(activity,route,"POST",200,path,"application/zip",epoch+skew+300000,epoch+skew,1000000);
        SiteMediaProxy.Grant grant=grants(activity).get(path);check(grant!=null&&grant.expiresAt==1299000L&&grant.spec.origin.toString().equals("https://example.invalid/"),"actual ZIP grant remembers conservative monotonic expiry");zipGrantChecks++;
      }
      android.os.SystemClock.value=1120000;remember(activity,project,"POST",200,path,"application/zip",epoch+300000,epoch,1000000);check(grants(activity).get(path).expiresAt==1299000L,"120-second generation never extends TTL");zipGrantChecks++;
      for(long delta:new long[]{0,1000,120000,301000,600000}){final long expiry=epoch+delta;reject(()->remember(activity,project,"POST",200,path,"application/zip",expiry,epoch,1000000));}
      reject(()->remember(activity,mediaRoute,"POST",200,path,"application/zip",epoch+300000,epoch,1000000));reject(()->remember(activity,project,"POST",200,"/api/engineering-site-media/"+TOKEN,"application/pdf",epoch+300000,epoch,1000000));
      check(grants(activity).size()==1,"wrong-kind response did not create an extra grant");zipGrantChecks++;
      remember(activity,project,"GET",200,path,"application/zip",epoch+300000,epoch,1000000);check(grants(activity).size()==1,"GET cannot add grants");zipGrantChecks++;
      remember(activity,"/api/mobile/me","GET",401,path,"application/zip",epoch+300000,epoch,1000000);check(grants(activity).isEmpty(),"401 clears native grants");zipGrantChecks++;
      long now=1000240,start=1000000;for(long skew:new long[]{-86400000,-300000,-2000,0,2000,300000,86400000})for(long precision:new long[]{0,1,999}){long date=epoch+skew,deadline=SiteGrantExpiry.deadline(date+300000+precision,date,start,now);check(deadline==now+300000+precision-1000-(now-start),"original monotonic grant clock rule retained");zipGrantChecks++;}
      for(long delta:new long[]{-1,0,1,999,1000,1240,301000,600000,Long.MAX_VALUE-epoch})reject(()->SiteGrantExpiry.deadline(epoch+delta,epoch,start,now));
      reject(()->SiteGrantExpiry.deadline(epoch+300000,0,start,now));reject(()->SiteGrantExpiry.deadline(epoch+300000,epoch,-1,now));reject(()->SiteGrantExpiry.deadline(epoch+300000,epoch,now,start));
    }finally{finish(activity);}
  }
  static int zipTransferChecks=0;
  static void zipTransferCases()throws Exception {
    final long length=268435456L+17;final byte[] block=new byte[16384];for(int i=0;i<block.length;i++)block[i]=(byte)(i%251);java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");for(long left=length;left>0;){int count=(int)Math.min(left,block.length);digest.update(block,0,count);left-=count;}String sha=SiteMediaDownload.hex(digest.digest());
    String path="/api/engineering-site-packages/"+TOKEN;final int[] mode={0},redirects={0};final boolean[] authenticated={false};com.sun.net.httpserver.HttpServer server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
    server.createContext("/elsewhere",exchange->{redirects[0]++;exchange.sendResponseHeaders(404,-1);exchange.close();});
    server.createContext(path,exchange->{try{
      authenticated[0]=("Bearer "+TOKEN).equals(exchange.getRequestHeaders().getFirst("Authorization"))&&"identity".equals(exchange.getRequestHeaders().getFirst("Accept-Encoding"))&&"1".equals(exchange.getRequestHeaders().getFirst("X-Workspace-Request"));int value=mode[0];if(value>=400){exchange.sendResponseHeaders(value,-1);return;}if(value==1){exchange.getResponseHeaders().add("Location","/elsewhere");exchange.sendResponseHeaders(302,-1);return;}
      exchange.getResponseHeaders().add("Content-Type",value==2?"text/html":"application/zip");exchange.getResponseHeaders().add("X-Content-SHA256",value==3?String.join("",Collections.nCopies(64,"0")):sha);
      exchange.sendResponseHeaders(200,value==4?9:length);try(OutputStream output=exchange.getResponseBody()){for(long left=value==4?9:length;left>0;){int count=(int)Math.min(left,block.length);output.write(block,0,count);left-=count;}}
    }catch(IOException cancelled){}finally{exchange.close();}});server.start();String base="http://127.0.0.1:"+server.getAddress().getPort();
    try{
      final long[] written={0};final java.security.MessageDigest copied=java.security.MessageDigest.getInstance("SHA-256");SiteMediaDownload.Spec spec=new SiteMediaDownload.Spec(base,path,TOKEN,"资料.zip","application/zip",length,sha);OutputStream sink=new OutputStream(){public void write(int value){written[0]++;copied.update((byte)value);}public void write(byte[] data,int offset,int count){written[0]+=count;copied.update(data,offset,count);}};
      SiteMediaDownload.Result result=SiteMediaDownload.transfer(spec,sink,new SiteMediaDownload.Cancellation());check(result.bytes==length&&written[0]==length&&result.sha256.equals(sha)&&sha.equals(SiteMediaDownload.hex(copied.digest()))&&authenticated[0],"ZIP larger than old video limit is streamed in bounded blocks");zipTransferChecks++;
      for(int value:new int[]{1,2,3,4,401,403,404,410}){mode[0]=value;reject(()->SiteMediaDownload.transfer(spec,new ByteArrayOutputStream(),new SiteMediaDownload.Cancellation()));zipTransferChecks++;}check(redirects[0]==0,"ZIP redirect never followed");zipTransferChecks++;
      mode[0]=0;SiteMediaDownload.Cancellation cancel=new SiteMediaDownload.Cancellation();try{SiteMediaDownload.transfer(spec,new OutputStream(){public void write(int value){cancel.cancel();}public void write(byte[] data,int offset,int count){cancel.cancel();}},cancel);throw new AssertionError("stream cancellation ignored");}catch(Exception expected){check(cancel.cancelled(),"active stream cancelled");zipTransferChecks++;}
    }finally{server.stop(0);}
  }
  static int zipRequestChecks=0;
  static void zipRequestCases(File cache)throws Exception{
    final int[] requests={0};com.sun.net.httpserver.HttpServer server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);server.createContext("/",exchange->{requests[0]++;exchange.getResponseHeaders().add("Content-Type","application/json");exchange.sendResponseHeaders(403,2);try(OutputStream output=exchange.getResponseBody()){output.write(new byte[]{123,125});}finally{exchange.close();}});server.start();String base="http://127.0.0.1:"+server.getAddress().getPort(),id="12345678-1234-1234-1234-123456789abc",p="/api/mobile/engineering/projects/"+id,global="/api/mobile/engineering/site-library";
    TestActivity activity=new TestActivity(cache,new Provider(new File(cache,"request-unused"),"",true));WebView web=new WebView();field(activity,"web",web);Method network=MainActivity.class.getDeclaredMethod("network",String.class,String.class);network.setAccessible(true);
    try{
      String[][] valid={{"GET",global+"?date=2026-10-21"},{"GET",p+"/site-library?date=2026-10-21"},{"POST",global+"/packages"},{"POST",p+"/site-library/packages"},{"POST",p+"/wbs/project-scope"}};
      for(String[] pair:valid){int before=requests[0];String config="{\"baseUrl\":\""+base+"\",\"path\":\""+pair[1]+"\",\"method\":\""+pair[0]+"\",\"token\":\""+TOKEN+"\",\"body\":\"{}\"}";network.invoke(activity,"request",config);check(requests[0]==before+1,"actual network accepts exact library request");zipRequestChecks++;}
      String[][] bad={{"POST",global+"/packages?x=1"},{"POST",p+"/site-library/packages?x=1"},{"POST",p+"/wbs/project-scope?x=1"},{"GET",global.replace("library","librar%79")},{"POST",p+"/site-library/packages"+"/extra"},{"POST",p.replace("12345678","%31%32%33%34%35%36%37%38")+"/site-library/packages"},{"POST",p.replace(id,"------------------------------------")+"/site-library/packages"},{"GET",global+"/packages"},{"GET","/api/engineering-site-packages/"+TOKEN},{"GET","/api/mobile/engineering-site-packages/"+TOKEN},{"POST",p+"/site-library/files"},{"DELETE",global},{"GET","https://foreign.invalid"+global},{"GET","//foreign.invalid"+global}};
      for(String[] pair:bad){int before=requests[0],callbacks=web.callbacks.size();String config="{\"baseUrl\":\""+base+"\",\"path\":\""+pair[1]+"\",\"method\":\""+pair[0]+"\",\"token\":\""+TOKEN+"\",\"body\":\"{}\"}";network.invoke(activity,"request",config);check(requests[0]==before&&web.callbacks.size()==callbacks+1&&web.callbacks.get(callbacks).contains("error"),"actual network rejects unsafe ZIP request before contacting server: "+Arrays.toString(pair));zipRequestChecks++;}
    }finally{finish(activity);server.stop(0);}
  }
  public static void main(String[] args)throws Exception {
    File cache=new File(args[0]);cache.mkdirs();
    saveCase(cache,"",true);for(String fail:new String[]{"open","null","write","flush","close"})saveCase(cache,fail,true);saveCase(cache,"close",false);
    cameraCases(cache);pickerCases(cache);zipCases(cache);zipBoundaryCases();zipRouteCases();zipGrantCases(cache);zipTransferCases();zipRequestCases(cache);
    System.out.println("{\"zipRequestChecks\":"+zipRequestChecks+",\"zipStreamedBytes\":"+(268435456L+17)+",\"zipTransferChecks\":"+zipTransferChecks+",\"zipBoundaryChecks\":"+zipBoundaryChecks+",\"zipRouteChecks\":"+zipRouteChecks+",\"zipGrantChecks\":"+zipGrantChecks+",\"actualMainActivityResultBranchExecuted\":true,\"saveProviderCasesPassed\":7,\"saveCallbacksOnce\":true,\"writeFlushAndCloseFailureNeverSaved\":true,\"failedOutputDeletedOrTruncated\":true,\"originalSaveBytesUnchanged\":true,\"captureCasesPassed\":6,\"providerBoundaryCasesPassed\":5,\"pickerCasesPassed\":3,\"oldCaptureNotReturned\":true,\"successfulCaptureKeptReadable\":true,\"independentCaptureBytes\":true,\"externalCameraGrantsRevoked\":true}");
  }
}
''')
classpath=os.pathsep.join(map(str,[OUT/'classes',PLATFORM]))
host_sources=sorted((OUT/'host-src').rglob('*.java'))
run([JAVA/'bin/javac','-encoding','UTF-8','--release','8','-classpath',classpath,'-d',OUT/'host-classes',*host_sources],'host-harness-compile')
runtime=os.pathsep.join(map(str,[OUT/'host-classes',OUT/'classes',PLATFORM]))
evidence=json.loads(run([JAVA/'bin/java','-cp',runtime,'cn.smartengineering.dailyreport.NativeMediaHarness',OUT/'fixture-cache'],'host-harness'))
evidence.update({'zipProviderCasesPassed':8,'zipSystemPickerCancellationPassed':True,'actualZipSaveBranchExecuted':True,'passed':True,'androidAllJavaCompiled':True,'minApi26D8Passed':True,'physicalPhoneTested':False,'productionConnected':False,'signedOrPublished':False,'sourceSha256':{str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in [NATIVE/name for name in ['MainActivity.java','EngineeringRoutes.java','SiteGrantExpiry.java','SiteMediaDownload.java','SiteMediaProxy.java','PhotoProvider.java','NativeFileSave.java','CameraCaptureFiles.java']]}})
(OUT/'receipt.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
print(json.dumps(evidence,ensure_ascii=False))
