package cn.smartengineering.dailyreport;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.UUID;

/** Each camera request owns a new, initially empty output; completed originals stay readable in cache. */
final class CameraCaptureFiles {
  private static File directory(File cache) throws IOException {
    File directory=new File(cache,"camera-captures");
    if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Camera cache unavailable");
    return directory;
  }
  static File create(File cache) throws IOException {
    File directory=directory(cache);
    for(int attempt=0;attempt<3;attempt++) {
      File file=new File(directory,"capture-"+UUID.randomUUID().toString()+".jpg");
      if(file.createNewFile())return file;
    }
    throw new IOException("Cannot create camera output");
  }
  static File resolve(File cache,String name) throws FileNotFoundException {
    if(name==null||!name.matches("capture-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.jpg"))throw new FileNotFoundException();
    try {
      File directory=new File(cache,"camera-captures").getCanonicalFile();
      File file=new File(directory,name).getCanonicalFile();
      if(!directory.equals(file.getParentFile())||!file.isFile())throw new FileNotFoundException();
      return file;
    }catch(IOException error){throw new FileNotFoundException();}
  }
  static boolean hasOutput(File file){return file!=null&&file.isFile()&&file.length()>0;}
  static void discard(File file){if(file!=null)file.delete();}
  private CameraCaptureFiles(){}
}
