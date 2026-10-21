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

/** Only exposes the single verified update APK through temporary URI grants. */
public class UpdateProvider extends ContentProvider {
  @Override public boolean onCreate(){return true;}
  private File file(Uri uri) throws FileNotFoundException {
    if(!"/verified.apk".equals(uri.getPath()) || ! (getContext().getPackageName()+".updates").equals(uri.getAuthority()))throw new FileNotFoundException();
    File file=new File(getContext().getCacheDir(),"updates/verified.apk");if(!file.isFile())throw new FileNotFoundException();return file;
  }
  @Override public String getType(Uri uri){return "application/vnd.android.package-archive";}
  @Override public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException {if(!"r".equals(mode))throw new FileNotFoundException();return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.MODE_READ_ONLY);}
  @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){try {File file=file(uri);MatrixCursor result=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});result.addRow(new Object[]{"smart-engineering-update.apk",file.length()});return result;}catch(Exception e){return null;}}
  @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
  @Override public int update(Uri uri,ContentValues values,String where,String[] args){throw new UnsupportedOperationException();}
  @Override public int delete(Uri uri,String where,String[] args){throw new UnsupportedOperationException();}
}
