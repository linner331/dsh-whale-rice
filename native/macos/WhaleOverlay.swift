// whale-overlay: transparent, click-through, always-on-top windows (one per screen) that host the
// whale page outside the DeepSeek Harness window. Spawned and killed by the plugin's node half.
//
//   whale-overlay --url http://127.0.0.1:<port>/?t=<token> --ppid <pid>
//
// The page decides what is interactive: it posts {type:"hit", rects:[[x,y,w,h],…], capture:Bool}
// and this process lets mouse events through everywhere else.
import AppKit
import WebKit

final class OverlayWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class OverlayPanel: NSPanel {
  override var canBecomeKey: Bool { true }   // needed for Escape while drawing a region
}

func log(_ text: String) {
  FileHandle.standardError.write("[whale-overlay] \(text)\n".data(using: .utf8)!)
}

final class ScreenOverlay: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let panel: OverlayPanel
  let web: OverlayWebView
  var hitRects: [CGRect] = []
  var capture = false

  init(screen: NSScreen, baseURL: URL, mainHeight: CGFloat, allScreens: String) {
    let frame = screen.frame
    panel = OverlayPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false

    let config = WKWebViewConfiguration()
    let controller = WKUserContentController()
    config.userContentController = controller
    web = OverlayWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
    web.setValue(false, forKey: "drawsBackground")
    web.autoresizingMask = [.width, .height]
    super.init()
    controller.add(self, name: "whale")
    web.navigationDelegate = self
    panel.contentView = web

    // Screen rect in top-left-origin global coordinates (what the page and the stored region use).
    let top = mainHeight - frame.maxY
    var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    comps.queryItems = (comps.queryItems ?? []) + [
      URLQueryItem(name: "sx", value: "\(Int(frame.minX))"), URLQueryItem(name: "sy", value: "\(Int(top))"),
      URLQueryItem(name: "sw", value: "\(Int(frame.width))"), URLQueryItem(name: "sh", value: "\(Int(frame.height))"),
      // Every connected screen, so a region left on an unplugged one can be noticed.
      URLQueryItem(name: "screens", value: allScreens),
    ]
    web.load(URLRequest(url: comps.url!))
    panel.orderFrontRegardless()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { log("loaded \(webView.url?.path ?? "?")") }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { log("load failed: \(error)") }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    log("provisional load failed: \(error)")
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { log("web content process terminated"); webView.reload() }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    if body["type"] as? String == "log" { return log("page: \(body["text"] ?? "")") }
    guard body["type"] as? String == "hit" else { return }
    capture = body["capture"] as? Bool ?? false
    hitRects = (body["rects"] as? [[Double]] ?? []).compactMap { r in
      r.count == 4 ? CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil
    }
    if capture { panel.makeKey() }
  }

  /// Toggle click-through based on where the mouse is (global Cocoa coordinates in).
  func track(mouse: NSPoint) {
    let f = panel.frame
    let local = CGPoint(x: mouse.x - f.minX, y: f.maxY - mouse.y)
    let interactive = capture || hitRects.contains { $0.insetBy(dx: -2, dy: -2).contains(local) }
    if panel.ignoresMouseEvents == interactive { panel.ignoresMouseEvents = !interactive }
  }

  func close() {
    web.configuration.userContentController.removeScriptMessageHandler(forName: "whale")
    panel.close()
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  let baseURL: URL
  let parentPid: pid_t
  var overlays: [ScreenOverlay] = []
  var timer: Timer?

  init(baseURL: URL, parentPid: pid_t) {
    self.baseURL = baseURL
    self.parentPid = parentPid
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    build()
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.build() }
    timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
  }

  func build() {
    overlays.forEach { $0.close() }
    let mainHeight = NSScreen.screens.first?.frame.height ?? 0
    let all = NSScreen.screens.map { s in
      let f = s.frame
      return "\(Int(f.minX)),\(Int(mainHeight - f.maxY)),\(Int(f.width)),\(Int(f.height))"
    }.joined(separator: ";")
    overlays = NSScreen.screens.map { ScreenOverlay(screen: $0, baseURL: baseURL, mainHeight: mainHeight, allScreens: all) }
  }

  var ticks = 0
  func tick() {
    let mouse = NSEvent.mouseLocation
    overlays.forEach { $0.track(mouse: mouse) }
    ticks += 1
    // Exit with the DSH host even if it died without killing us.
    if ticks % 30 == 0, parentPid > 0, kill(parentPid, 0) != 0 { NSApp.terminate(nil) }
  }
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

guard let urlString = argument("--url"), let url = URL(string: urlString) else {
  FileHandle.standardError.write("usage: whale-overlay --url <url> [--ppid <pid>]\n".data(using: .utf8)!)
  exit(2)
}
signal(SIGTERM) { _ in exit(0) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate(baseURL: url, parentPid: pid_t(argument("--ppid") ?? "") ?? 0)
app.delegate = delegate
app.run()
