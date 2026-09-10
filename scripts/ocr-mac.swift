import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count >= 2 else { exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard
  let image = NSImage(contentsOf: url),
  let tiff = image.tiffRepresentation,
  let rep = NSBitmapImageRep(data: tiff),
  let cg = rep.cgImage
else { exit(3) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
