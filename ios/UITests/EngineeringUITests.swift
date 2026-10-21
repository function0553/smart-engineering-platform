import XCTest

@MainActor
final class EngineeringUITests: XCTestCase {
    func testPlatformConnectionNavigationAndWordShare() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["SMART_IOS_QA_WORD"] = try Data(contentsOf: Bundle(for: Self.self).url(forResource: "native-qa", withExtension: "docx")!).base64EncodedString()
        app.launch()
        XCTAssertTrue(app.webViews.textFields.firstMatch.waitForExistence(timeout: 50), "252 TLS connection and mobile login page")
        capture("ios-native-login")
        app.navigationBars.buttons["更多"].tap()
        XCTAssertTrue(app.buttons["检查APP更新"].exists)
        app.buttons["检查APP更新"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 35))
        XCTAssertTrue(app.alerts.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "尚未上架")).firstMatch.exists, "Unlisted build must not claim a published App Store update")
        capture("ios-native-update-unlisted")
        app.alerts.buttons["知道了"].tap()
        app.navigationBars.buttons["更多"].tap()
        app.buttons["重新加载页面…"].tap()
        XCTAssertTrue(app.alerts["重新加载页面？"].waitForExistence(timeout: 5))
        app.alerts.buttons["继续填写"].tap()
        XCUIDevice.shared.orientation = .landscapeLeft
        capture("ios-native-landscape")
        XCUIDevice.shared.orientation = .portrait
        let download = app.webViews.buttons["原生Word下载测试"]
        XCTAssertTrue(download.waitForExistence(timeout: 10))
        download.tap()
        XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 20) || app.buttons["Copy"].waitForExistence(timeout: 10) || app.buttons["Save to Files"].exists, "Native iOS share/save sheet")
        capture("ios-native-word-share")
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
