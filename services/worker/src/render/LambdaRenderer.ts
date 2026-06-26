// LambdaRenderer (M7 §2 — DOCUMENTED FUTURE DROP-IN, intentionally NOT implemented).
//
// Remotion Lambda is the autoscaling render path noted in the milestone as a later
// drop-in behind the SAME `Renderer` interface (render(edl, srcMap) → { videoPath,
// thumbnailPath, durationMs }) — so the render-montage job and the API/job contract
// change ZERO when we swap RemotionRenderer → LambdaRenderer.
//
// When built, this class would implement `Renderer` by calling
// `renderMediaOnLambda({ functionName, serveUrl, composition: "Montage", inputProps:
// { edl, srcMap }, codec: "h264", ... })` from `@remotion/lambda/client`, polling
// `getRenderProgress`, then downloading the output mp4 + a `renderStillOnLambda`
// thumbnail to local paths (mirroring RemotionRenderer's return shape). The user
// media in `srcMap` would be presigned S3 URLs (no local media server needed on
// Lambda). Deferred — see M7 §2 "Remotion Lambda → future".
export {};
