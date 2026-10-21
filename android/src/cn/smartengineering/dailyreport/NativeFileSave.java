package cn.smartengineering.dailyreport;

import java.io.IOException;
import java.io.OutputStream;

/** Finishes the provider stream before sending exactly one terminal save callback. */
final class NativeFileSave {
  interface Destination {
    OutputStream open() throws IOException;
    void discard();
  }
  interface Completion {
    void saved();
    void failed();
  }
  static void save(byte[] bytes,Destination destination,Completion completion) {
    try {
      try(OutputStream output=destination.open()) {
        if(output==null)throw new IOException("No output stream");
        output.write(bytes);output.flush();
      }
    }catch(Exception failure) {
      // Deletion/truncation is best effort, but its own failure must not suppress the error callback.
      try{destination.discard();}catch(Exception ignored){}
      completion.failed();return;
    }
    // Kept outside both the stream scope and catch: success cannot precede close or become two callbacks.
    completion.saved();
  }
  private NativeFileSave(){}
}
