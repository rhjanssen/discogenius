import React, { Fragment } from "react";
import { tokens } from "@fluentui/react-components";

type NavigateFn = (path: string) => void;

export function parseWimpLinks(text: string, navigate: NavigateFn): React.ReactNode {
  if (!text) return null;

  const normalized = text.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/<br\s*\/?>|\n/gi);

  const wimpLinkRegex = /\[wimpLink\s+(artistId|albumId)="(\d+)"\]([\s\S]*?)\[\/wimpLink\]/g;

  const parseParagraph = (paragraph: string, paragraphIndex: number) => {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    while ((match = wimpLinkRegex.exec(paragraph)) !== null) {
      if (match.index > lastIndex) {
        parts.push(
          <Fragment key={`${paragraphIndex}-text-${key++}`}>
            {paragraph.slice(lastIndex, match.index)}
          </Fragment>
        );
      }

      const [, type, id, linkText] = match;
      const path = type === "artistId" ? `/artist/${id}` : `/album/${id}`;

      parts.push(
        <span
          key={`${paragraphIndex}-link-${key++}`}
          onClick={(event) => {
            event.stopPropagation();
            navigate(path);
          }}
          style={{
            color: tokens.colorBrandForeground1,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {linkText}
        </span>
      );

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < paragraph.length) {
      parts.push(
        <Fragment key={`${paragraphIndex}-text-${key++}`}>
          {paragraph.slice(lastIndex)}
        </Fragment>
      );
    }

    wimpLinkRegex.lastIndex = 0;

    return parts.length > 0 ? parts : paragraph;
  };

  return paragraphs.map((paragraph, index) => {
    const trimmed = paragraph.trim();
    if (!trimmed) return null;
    return (
      <p
        key={index}
        style={{
          marginBottom: index < paragraphs.length - 1 ? tokens.spacingVerticalM : 0,
        }}
      >
        {parseParagraph(trimmed, index)}
      </p>
    );
  });
}
