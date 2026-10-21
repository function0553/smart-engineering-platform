package cn.smartengineering.dailyreport;

import java.util.LinkedHashSet;
import java.util.Locale;

/** Explicit document types used by the bundled forms; independent of Android for regression testing. */
final class DocumentAcceptTypes {
  static String[] resolve(String[] accept) {
    LinkedHashSet<String> types=new LinkedHashSet<>();
    if(accept!=null)for(String group:accept)if(group!=null)for(String value:group.split(",")) {
      String item=value.trim().toLowerCase(Locale.ROOT);
      if(item.startsWith("image/")||item.equals(".jpg")||item.equals(".jpeg")||item.equals(".png"))types.add("image/*");
      else if(item.equals(".pdf")||item.equals("application/pdf"))types.add("application/pdf");
      else if(item.equals(".mp4")||item.equals("video/mp4"))types.add("video/mp4");
      else if(item.equals(".webm")||item.equals("video/webm"))types.add("video/webm");
      else if(item.equals(".docx")||item.equals("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))types.add("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      else if(item.equals(".xlsx")||item.equals("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))types.add("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      else if(item.equals(".csv")||item.equals("text/csv")) {
        types.add("text/csv");types.add("text/comma-separated-values");types.add("text/plain");types.add("application/vnd.ms-excel");
      } else if(item.equals(".json")||item.equals("application/json"))types.add("application/json");
    }
    // Preserve the existing JSON import fallback. A provider's MIME label is not file validation.
    if(types.isEmpty())types.add("application/json");
    return types.toArray(new String[0]);
  }
}
