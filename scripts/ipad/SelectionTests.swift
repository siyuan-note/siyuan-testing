import XCTest

final class SelectionTests: XCTestCase {
    struct Point: Decodable {
        let x: Double
        let y: Double
    }

    struct Gesture: Decodable {
        let kind: String?
        let start: Point
        let end: Point
        let viewport: Viewport
    }

    struct Viewport: Decodable {
        let width: Double
        let height: Double
    }

    func testDrag() throws {
        continueAfterFailure = false
        let value = try XCTUnwrap(ProcessInfo.processInfo.environment["SIYUAN_GESTURE"])
        let gesture = try JSONDecoder().decode(Gesture.self, from: Data(value.utf8))
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.activate()
        let webView = safari.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 10))
        // Safari 的无障碍 WebView 包含顶部工具栏，按页面视口换算系统触摸坐标。
        let scale = safari.frame.width / gesture.viewport.width
        let topInset = safari.frame.height - gesture.viewport.height * scale
        XCTAssertGreaterThanOrEqual(topInset, 0)
        let origin = safari.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
        let start = origin.withOffset(CGVector(dx: gesture.start.x * scale, dy: topInset + gesture.start.y * scale))
        let end = origin.withOffset(CGVector(dx: gesture.end.x * scale, dy: topInset + gesture.end.y * scale))
        if gesture.kind == "tap" {
            start.tap()
        } else {
            start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
        }
        let screenshot = XCTAttachment(screenshot: safari.screenshot())
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
