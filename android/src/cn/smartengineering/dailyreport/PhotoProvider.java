package cn.smartengineering.dailyreport;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Per-capture originals, writable only through Android URI permission grants. */
public class PhotoProvider extends ContentProvider {
  @Override public boolean onCreate(){return true;}
  private File file(Uri uri) throws FileNotFoundException {
    String path=uri.getPath();
    if(path==null || !path.startsWith("/captures/") || !(getContext().getPackageName()+".photos").equals(uri.getAuthority()))throw new FileNotFoundException();
    return CameraCaptureFiles.resolve(getContext().getCacheDir(),path.substring("/captures/".length()));
  }
  @Override public String getType(Uri uri){try{file(uri);return "image/jpeg";}catch(FileNotFoundException error){return null;}}
  @Override public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException {return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.parseMode(mode));}
  @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){try{File f=file(uri);MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});c.addRow(new Object[]{"现场拍照.jpg",f.length()});return c;}catch(Exception e){return null;}}
  @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
  @Override public int update(Uri uri,ContentValues values,String where,String[] args){throw new UnsupportedOperationException();}
  @Override public int delete(Uri uri,String where,String[] args){throw new UnsupportedOperationException();}
}
