package cn.smartengineering.dailyreport;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

/** Bounded original-file transfer. A registered server grant is checked separately by MainActivity. */
final class SiteMediaDownload {
  static final long DOCUMENT_LIMIT=16L*1024*1024, VIDEO_LIMIT=256L*1024*1024, PACKAGE_LIMIT=1024L*1024*1024;
  private static final String MEDIA_PATH="/api/engineering-site-media/[A-Za-z0-9_-]{43}";
  private static final String PACKAGE_PATH="/api/engineering-site-packages/[A-Za-z0-9_-]{43}";
  static final class Failure extends IOException {
    Failure(String message){super(message);}
  }
  static final class Cancellation {
    private volatile boolean cancelled;
    private HttpURLConnection connection;
    synchronized void attach(HttpURLConnection value) throws Failure {
      if(cancelled){value.disconnect();throw new Failure("已取消下载");}connection=value;
    }
    synchronized void detach(){connection=null;}
    synchronized void cancel(){cancelled=true;if(connection!=null)connection.disconnect();}
    boolean cancelled(){return cancelled || Thread.currentThread().isInterrupted();}
    void check() throws Failure {if(cancelled())throw new Failure("已取消下载");}
  }
  static final class Spec {
    final URI origin;
    final String path,token,name,mime,sha256;
    final long bytes;
    Spec(String baseUrl,String path,String token,String name,String mime,long bytes,String sha256) throws Exception {
      this.origin=origin(baseUrl);
      URI relative=new URI(path);
      if(relative.isAbsolute()||relative.getRawAuthority()!=null||relative.getQuery()!=null||relative.getFragment()!=null||!(path.matches(MEDIA_PATH)||path.matches(PACKAGE_PATH)))throw new Failure("下载地址无效，请重新打开资料");
      if(token==null||!token.matches("[A-Za-z0-9_-]{43}"))throw new Failure("登录信息无效，请重新登录");
      if(name==null||name.trim().isEmpty()||name.length()>160||name.trim().equals(".")||name.trim().equals("..")||!name.matches("[^\\p{Cntrl}/\\\\]+"))throw new Failure("文件名称无效，请重新打开资料");
      boolean packaged=path.matches(PACKAGE_PATH);
      if(packaged?!"application/zip".equals(mime):!Arrays.asList("application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","image/jpeg","image/png","image/webp","video/mp4","video/webm").contains(mime))throw new Failure("该文件类型暂不支持下载");
      if(bytes<1||bytes>(packaged?PACKAGE_LIMIT:mime.startsWith("video/")?VIDEO_LIMIT:DOCUMENT_LIMIT)||sha256==null||!sha256.matches("[0-9a-f]{64}"))throw new Failure("文件校验信息无效，请重新打开资料");
      this.path=path;this.token=token;this.name=name.trim();this.mime=mime;this.bytes=bytes;this.sha256=sha256;
    }
    boolean packaged(){return path.matches(PACKAGE_PATH);}
  }
  static final class Result {
    final long bytes;final String sha256;
    Result(long bytes,String sha256){this.bytes=bytes;this.sha256=sha256;}
  }
  static URI origin(String address) throws Exception {
    URI base=new URI(address);
    if(!("https".equals(base.getScheme())||"http".equals(base.getScheme()))||base.getHost()==null||base.getUserInfo()!=null||base.getQuery()!=null||base.getFragment()!=null||!(base.getPath()==null||base.getPath().isEmpty()||base.getPath().equals("/"))||base.getPort()<-1||base.getPort()>65535)throw new Failure("后台地址无效");
    int port=base.getPort();if(("https".equals(base.getScheme())&&port==443)||("http".equals(base.getScheme())&&port==80))port=-1;
    return new URI(base.getScheme(),null,base.getHost().toLowerCase(Locale.ROOT),port,"/",null,null);
  }
  // The server may advertise its public host to a client configured with the internal host.
  // The response contributes only a validated grant path; the configured origin remains authoritative.
  static String grantPath(String address) throws Exception {
    URI grant=new URI(address);String path=grant.getPath();
    if(grant.getUserInfo()!=null||grant.getQuery()!=null||grant.getFragment()!=null||path==null||!(path.matches(MEDIA_PATH)||path.matches(PACKAGE_PATH))||!path.equals(grant.getRawPath()))throw new Failure("下载授权无效");
    if(grant.isAbsolute()&&(!("http".equals(grant.getScheme())||"https".equals(grant.getScheme()))||grant.getHost()==null))throw new Failure("下载授权无效");
    if(!grant.isAbsolute()&&grant.getRawAuthority()!=null)throw new Failure("下载授权无效");
    return path;
  }
  static boolean authorized(Spec spec,String registeredOrigin,String registeredToken,long expiresAt,long now){return expiresAt>now&&spec.origin.toString().equals(registeredOrigin)&&spec.token.equals(registeredToken);}
  static Result transfer(Spec spec,OutputStream output,Cancellation cancellation) throws Exception {
    cancellation.check();HttpURLConnection connection=(HttpURLConnection)spec.origin.resolve(spec.path).toURL().openConnection();
    try {
      cancellation.attach(connection);connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(12000);connection.setReadTimeout(60000);connection.setRequestMethod("GET");
      connection.setRequestProperty("Accept-Encoding","identity");connection.setRequestProperty("Authorization","Bearer "+spec.token);connection.setRequestProperty("X-Workspace-Request","1");
      int status=connection.getResponseCode();cancellation.check();
      if(status!=200){if(status==401||status==403)throw new Failure("登录或项目权限已变更，请重新打开资料");if(status==404||status==410)throw new Failure("文件或下载授权已失效，请重新打开资料");throw new Failure("文件下载失败，请检查网络后重试");}
      if(spec.packaged()){
        String contentType=connection.getContentType();String checksum=connection.getHeaderField("X-Content-SHA256");
        if(contentType==null||!spec.mime.equals(contentType.split(";",2)[0].trim().toLowerCase(Locale.ROOT))||checksum!=null&&!spec.sha256.equals(checksum))throw new Failure("资料包类型或校验信息无效，已停止保存");
      }
      long reported=connection.getContentLengthLong();if(reported>=0&&reported!=spec.bytes)throw new Failure("原文件大小校验失败，已停止保存");
      MessageDigest digest=MessageDigest.getInstance("SHA-256");long total=0;
      try(InputStream input=connection.getInputStream()){
        byte[] block=new byte[16384];int count;while((count=input.read(block))!=-1){cancellation.check();total+=count;if(total>spec.bytes)throw new Failure("原文件大小校验失败，已停止保存");digest.update(block,0,count);output.write(block,0,count);}
      }
      cancellation.check();String checksum=hex(digest.digest());
      if(total!=spec.bytes||!checksum.equals(spec.sha256))throw new Failure("原文件校验失败，已停止保存");
      output.flush();return new Result(total,checksum);
    } finally {cancellation.detach();connection.disconnect();}
  }
  static String hex(byte[] digest){StringBuilder hex=new StringBuilder();for(byte b:digest)hex.append(String.format(Locale.ROOT,"%02x",b&255));return hex.toString();}
}
