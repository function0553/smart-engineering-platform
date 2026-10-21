package cn.smartengineering.dailyreport;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A self-origin WebView media proxy. Its target comes exclusively from authenticated grant metadata. */
final class SiteMediaProxy {
  static final String WEBVIEW_ORIGIN="https://appassets.androidplatform.net";
  private static final Pattern RANGE=Pattern.compile("bytes=(\\d*)-(\\d*)");
  private static final Pattern CONTENT_RANGE=Pattern.compile("bytes (\\d+)-(\\d+)/(\\d+)");
  static final class Grant {
    final SiteMediaDownload.Spec spec;final long expiresAt;
    Grant(SiteMediaDownload.Spec spec,long expiresAt){this.spec=spec;this.expiresAt=expiresAt;}
  }
  static final class Response {
    final String mime,reason;final int status;final Map<String,String> headers;final InputStream stream;
    Response(String mime,int status,String reason,Map<String,String> headers,InputStream stream){this.mime=mime;this.status=status;this.reason=reason;this.headers=headers;this.stream=stream;}
  }
  static boolean accepts(Grant grant,String address,String method,long now) {
    if(grant==null||grant.spec.packaged()||grant.expiresAt<=now||!(method.equals("GET")||method.equals("HEAD")))return false;
    try {
      URI uri=new URI(address);
      return "https".equals(uri.getScheme())&&"appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())&&(uri.getPort()==-1||uri.getPort()==443)&&uri.getUserInfo()==null&&uri.getQuery()==null&&uri.getFragment()==null&&grant.spec.path.equals(uri.getRawPath());
    }catch(Exception ignored){return false;}
  }
  static boolean sameOriginal(SiteMediaDownload.Spec requested,Grant grant,long now){return grant!=null&&SiteMediaDownload.authorized(requested,grant.spec.origin.toString(),grant.spec.token,grant.expiresAt,now)&&requested.path.equals(grant.spec.path)&&requested.bytes==grant.spec.bytes&&requested.sha256.equals(grant.spec.sha256)&&requested.mime.equals(grant.spec.mime)&&requested.name.equals(grant.spec.name);}
  private static String header(Map<String,String> headers,String name){if(headers!=null)for(Map.Entry<String,String> item:headers.entrySet())if(name.equalsIgnoreCase(item.getKey()))return item.getValue();return null;}
  private static String reason(int status){switch(status){case 200:return "OK";case 206:return "Partial Content";case 400:return "Bad Request";case 401:return "Unauthorized";case 403:return "Forbidden";case 404:return "Not Found";case 410:return "Gone";case 416:return "Range Not Satisfiable";case 429:return "Too Many Requests";case 503:return "Service Unavailable";default:return "Media Error";}}
  private static Response empty(int status){Map<String,String> headers=new HashMap<>();headers.put("Content-Length","0");headers.put("Cache-Control","private, no-store");headers.put("X-Content-Type-Options","nosniff");return new Response("text/plain",status,reason(status),headers,new ByteArrayInputStream(new byte[0]));}
  static Response open(Grant grant,String address,String method,Map<String,String> requestedHeaders,long now) throws Exception {
    if(grant==null)return empty(403);if(grant.expiresAt<=now)return empty(410);if(!accepts(grant,address,method,now))return empty(403);
    String range=header(requestedHeaders,"Range"),ifRange=header(requestedHeaders,"If-Range");long[] requestedRange=null;
    if(range!=null){requestedRange=parseRange(range,grant.spec.bytes);if(requestedRange==null)return empty(416);}
    if(ifRange!=null&&(ifRange.length()>200||!ifRange.matches("[\\x20-\\x7e]+")))return empty(400);
    HttpURLConnection connection=(HttpURLConnection)grant.spec.origin.resolve(grant.spec.path).toURL().openConnection();boolean handedOff=false;
    try {
      connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(12000);connection.setReadTimeout(60000);connection.setRequestMethod(method);
      connection.setRequestProperty("Authorization","Bearer "+grant.spec.token);connection.setRequestProperty("X-Workspace-Request","1");connection.setRequestProperty("Accept-Encoding","identity");
      if(range!=null)connection.setRequestProperty("Range",range);if(ifRange!=null)connection.setRequestProperty("If-Range",ifRange);
      int status=connection.getResponseCode();
      if(status!=200&&status!=206){if(status>=300&&status<400)return empty(502);if(status<400||status>599)return empty(502);Response error=empty(status);if(status==416&&("bytes */"+grant.spec.bytes).equals(connection.getHeaderField("Content-Range")))error.headers.put("Content-Range",connection.getHeaderField("Content-Range"));return error;}
      String mime=connection.getContentType();if(mime==null||!grant.spec.mime.equals(mime.split(";",2)[0].trim().toLowerCase(java.util.Locale.ROOT)))return empty(502);
      String checksum=connection.getHeaderField("X-Content-SHA256");if(checksum!=null&&!checksum.equals(grant.spec.sha256))return empty(502);
      long expected=grant.spec.bytes;String contentRange=connection.getHeaderField("Content-Range");
      if(status==206){long[] span=parseContentRange(contentRange,grant.spec.bytes);if(span==null||requestedRange==null||span[0]!=requestedRange[0]||span[1]!=requestedRange[1])return empty(502);expected=span[1]-span[0]+1;}
      else if(contentRange!=null)return empty(502);
      long reported=connection.getContentLengthLong();if(reported>=0&&reported!=expected)return empty(502);
      Map<String,String> headers=new HashMap<>();headers.put("Content-Type",grant.spec.mime);headers.put("Content-Length",String.valueOf(expected));headers.put("Accept-Ranges","bytes");headers.put("Cache-Control","private, no-store");headers.put("X-Content-Type-Options","nosniff");headers.put("Referrer-Policy","no-referrer");
      if(status==206)headers.put("Content-Range",contentRange);if(checksum!=null)headers.put("X-Content-SHA256",checksum);
      String etag=connection.getHeaderField("ETag"),modified=connection.getHeaderField("Last-Modified");if(etag!=null&&etag.length()<200&&!etag.matches(".*[\\r\\n].*"))headers.put("ETag",etag);if(modified!=null&&modified.length()<200&&!modified.matches(".*[\\r\\n].*"))headers.put("Last-Modified",modified);
      if(method.equals("HEAD"))return new Response(grant.spec.mime,status,reason(status),headers,new ByteArrayInputStream(new byte[0]));
      InputStream input=new BoundedStream(connection.getInputStream(),connection,expected);handedOff=true;return new Response(grant.spec.mime,status,reason(status),headers,input);
    }finally{if(!handedOff)connection.disconnect();}
  }
  private static long[] parseRange(String text,long total) {
    if(text.length()>100)return null;Matcher match=RANGE.matcher(text);if(!match.matches()||match.group(1).isEmpty()&&match.group(2).isEmpty())return null;
    try {
      long start,end=total-1;
      if(match.group(1).isEmpty()){long suffix=Long.parseLong(match.group(2));if(suffix<=0)return null;start=Math.max(0,total-suffix);}
      else{start=Long.parseLong(match.group(1));if(!match.group(2).isEmpty())end=Math.min(end,Long.parseLong(match.group(2)));}
      if(start<0||start>=total||end<start)return null;return new long[]{start,end};
    }catch(NumberFormatException ignored){return null;}
  }
  private static long[] parseContentRange(String text,long total){if(text==null||text.length()>100)return null;Matcher match=CONTENT_RANGE.matcher(text);if(!match.matches())return null;try{long start=Long.parseLong(match.group(1)),end=Long.parseLong(match.group(2)),reported=Long.parseLong(match.group(3));if(reported!=total||start<0||end<start||end>=total)return null;return new long[]{start,end};}catch(NumberFormatException ignored){return null;}}
  private static final class BoundedStream extends FilterInputStream {
    private final HttpURLConnection connection;private long remaining;private boolean closed,finished;
    BoundedStream(InputStream input,HttpURLConnection connection,long bytes){super(input);this.connection=connection;remaining=bytes;}
    @Override public int read() throws IOException {byte[] byteOne=new byte[1];int count=read(byteOne,0,1);return count<0?-1:byteOne[0]&255;}
    @Override public int read(byte[] bytes,int offset,int count) throws IOException {
      if(closed){if(finished)return -1;throw new IOException("Media stream closed");}if(count==0)return 0;
      try{
        if(remaining==0){int extra=in.read();if(extra!=-1)throw new IOException("Media length exceeded");finished=true;close();return -1;}
        int read=in.read(bytes,offset,(int)Math.min(count,remaining));if(read<0){if(remaining!=0)throw new IOException("Media length incomplete");close();return -1;}remaining-=read;return read;
      }catch(IOException error){close();throw error;}
    }
    @Override public long skip(long bytes) throws IOException {if(bytes<=0)return 0;byte[] block=new byte[(int)Math.min(bytes,16384)];long skipped=0;while(skipped<bytes){int read=read(block,0,(int)Math.min(block.length,bytes-skipped));if(read<0)break;skipped+=read;}return skipped;}
    @Override public int available() throws IOException {if(closed)return 0;return (int)Math.min(in.available(),remaining);}
    @Override public synchronized void mark(int readlimit){}
    @Override public synchronized void reset() throws IOException {throw new IOException("Media stream does not support reset");}
    @Override public boolean markSupported(){return false;}
    @Override public void close() throws IOException {if(closed)return;closed=true;try{super.close();}finally{connection.disconnect();}}
  }
}
