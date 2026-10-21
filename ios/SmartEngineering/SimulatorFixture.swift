#if DEBUG && targetEnvironment(simulator)
import Foundation
import WebKit

/// Synthetic test hook, absent from Release/device builds.
enum SimulatorFixture {
    static func install(in web: WKWebView) {
        guard let base64 = ProcessInfo.processInfo.environment["SMART_IOS_QA_WORD"],
              let data = try? JSONSerialization.data(withJSONObject: [base64]),
              let argument = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("""
          (() => {
            if(document.getElementById('native-qa-download'))return;
            const button=document.createElement('button');button.id='native-qa-download';
            button.textContent='原生Word下载测试';button.style='display:block;min-height:48px;margin:16px';
            button.onclick=()=>{const bytes=Uint8Array.from(atob(\(argument)[0]),c=>c.charCodeAt(0));
              const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
              a.download='native-qa.docx';a.click();};document.body.prepend(button);
          })();
        """, completionHandler: nil)
    }
    static func preserveDownloadedFixture(_ file: URL) {
        guard ProcessInfo.processInfo.environment["SMART_IOS_QA_WORD"] != nil,
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let target = documents.appendingPathComponent("native-qa-downloaded.docx")
        try? FileManager.default.removeItem(at: target)
        try? FileManager.default.copyItem(at: file, to: target)
    }
}
#endif
