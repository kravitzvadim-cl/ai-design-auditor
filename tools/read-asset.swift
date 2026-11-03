import Foundation
import Vision
import AppKit
import PDFKit

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}
guard CommandLine.arguments.count == 2 else { exit(1) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
if url.pathExtension.lowercased() == "pdf", let pdf = PDFDocument(url: url) {
    var pages: [String] = []
    for index in 0..<min(pdf.pageCount, 20) {
        guard let page = pdf.page(at: index) else { continue }
        let text = page.string ?? ""
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { pages.append(text) }
        else {
            let thumb = page.thumbnail(of: NSSize(width: 1600, height: 2200), for: .mediaBox)
            if let image = thumb.cgImage(forProposedRect: nil, context: nil, hints: nil) { pages.append(try recognize(image)) }
        }
    }
    print(pages.joined(separator: "\n\n"))
} else if let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 3000] as CFDictionary) {
    print(try recognize(image))
} else { exit(2) }
