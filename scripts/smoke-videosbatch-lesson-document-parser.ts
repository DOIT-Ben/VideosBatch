import assert from "node:assert/strict";
import {
  MAX_LESSON_FILE_BYTES,
  detectLessonDocumentType,
  normalizeLessonText,
  validateLessonFileSize
} from "../src/server/videosBatchWorkflow/lessonDocumentParser";

const pdf = Buffer.from("%PDF-1.7\nmock", "ascii");
const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
const doc = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);

assert.equal(detectLessonDocumentType("lesson.pdf", pdf), "pdf");
assert.equal(detectLessonDocumentType("lesson.docx", docx), "docx");
assert.equal(detectLessonDocumentType("lesson.doc", doc), "doc");

assert.throws(() => detectLessonDocumentType("lesson.txt", Buffer.from("hello")), /DOC|DOCX|PDF|unsupported/i);
assert.throws(() => detectLessonDocumentType("lesson.pdf", docx), /signature|PDF|match/i);
assert.throws(() => detectLessonDocumentType("lesson.doc", pdf), /signature|DOC|match/i);

assert.doesNotThrow(() => validateLessonFileSize(MAX_LESSON_FILE_BYTES));
assert.throws(() => validateLessonFileSize(MAX_LESSON_FILE_BYTES + 1), /25|large|size/i);
assert.throws(() => validateLessonFileSize(0), /empty|size/i);

assert.equal(
  normalizeLessonText("\uFEFF教学目标  \r\n\r\n\r\n\r\n教学过程\t  \r\n"),
  "教学目标\n\n\n教学过程"
);

console.log("VideosBatch lesson document parser contract smoke: PASS");
