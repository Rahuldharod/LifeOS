import React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { imagePreviewSource } from "./editorAssets.js";
import { lifeosLinkId } from "./lifeosLinks.js";

/** react-markdown drops unknown protocols; LifeOS object links must survive so they can be clicked (PB-007). */
const keepLifeosLinks = (url: string) => lifeosLinkId(url) ? url : defaultUrlTransform(url);

/** Rendered Markdown for notes: LifeOS links stay clickable and managed images are served by the API. */
export function MarkdownPreview({ markdown, empty }: { markdown: string; empty: string }) {
  const content = markdown || empty;
  return <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{content}</ReactMarkdown></div>;
}
