/**
 * Textract Document Processor
 *
 * Extracts text from PDF/image denial documents using Amazon Textract,
 * then applies pattern matching to identify Denial_Record fields.
 *
 * Supported formats: PDF, TIFF, PNG, JPEG
 */

import {
  TextractClient,
  AnalyzeDocumentCommand,
  Block,
  AnalyzeDocumentCommandInput,
} from '@aws-sdk/client-textract';
import { isValidISO8601, isValidUSDAmount, roundToUSD } from '../../shared/validation';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Confidence level for an extracted field */
export type ExtractionConfidence = 'high' | 'medium' | 'low';

/** Result of extracting a single field from document text */
export interface ExtractedFieldResult<T> {
  value: T | null;
  confidence: ExtractionConfidence;
  rawMatch: string | null;
}

/** Complete result of Textract extraction and field mapping */
export interface TextractExtractionResult {
  claim_id: ExtractedFieldResult<string>;
  patient_id: ExtractedFieldResult<string>;
  payer_id: ExtractedFieldResult<string>;
  denial_date: ExtractedFieldResult<string>;
  denied_amount: ExtractedFieldResult<number>;
  denial_reason: ExtractedFieldResult<string>;
  raw_text: string;
  page_count: number;
  extraction_timestamp: string;
}

/** Supported document formats for Textract processing */
export type SupportedFormat = 'pdf' | 'tiff' | 'png' | 'jpeg';

/** Input for the Textract processor */
export interface TextractProcessorInput {
  /** S3 bucket containing the document */
  s3Bucket: string;
  /** S3 key of the document */
  s3Key: string;
  /** Document format */
  format: SupportedFormat;
  /** Raw document bytes (for image formats: TIFF, PNG, JPEG) */
  documentBytes?: Uint8Array;
}

// ─── Patterns for Field Extraction ──────────────────────────────────────────

const CLAIM_ID_PATTERNS = [
  /(?:Claim\s*#|Claim\s*Number|Claim\s*ID|Claim\s*No\.?|ICN)\s*[:\-]\s*([A-Z0-9][A-Z0-9\-]{3,29})/i,
  /(?:Claim\s*#)\s*([A-Z0-9][A-Z0-9\-]{3,29})/i,
  /(?:Internal\s*Control\s*Number|Reference\s*#|Reference\s*Number)\s*[:\-]\s*([A-Z0-9][A-Z0-9\-]{3,29})/i,
  /(?:DCN|Document\s*Control\s*Number)\s*[:\-]\s*([A-Z0-9][A-Z0-9\-]{3,29})/i,
];

const PATIENT_ID_PATTERNS = [
  /(?:Member\s*ID|Patient\s*ID|Subscriber\s*ID|Member\s*#|Patient\s*#)\s*[:\-]?\s*([A-Z0-9\-]{4,30})/i,
  /(?:Beneficiary\s*ID|Enrollee\s*ID|Member\s*Number)\s*[:\-]?\s*([A-Z0-9\-]{4,30})/i,
  /(?:MBI|HIC\s*#|HICN)\s*[:\-]?\s*([A-Z0-9\-]{4,30})/i,
];

const PAYER_ID_PATTERNS = [
  /(?:Payer\s*ID|Plan\s*ID|Insurance\s*ID)\s*[:\-]\s*([A-Z0-9\-]{3,30})/i,
  /(?:Insurance\s*Company|Plan\s*Name|Health\s*Plan|Carrier)\s*[:\-]\s*(.{3,60})/i,
];

const DENIAL_DATE_PATTERNS = [
  /(?:Date\s*of\s*Denial|Determination\s*Date|Decision\s*Date|Denial\s*Date|Date\s*of\s*Determination)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  /(?:Date\s*of\s*Denial|Determination\s*Date|Decision\s*Date|Denial\s*Date)\s*[:\-]?\s*(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/i,
  /(?:Date\s*of\s*Denial|Determination\s*Date|Decision\s*Date|Denial\s*Date)\s*[:\-]?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
];

const DENIED_AMOUNT_PATTERNS = [
  /(?:denied|not\s*covered|adjusted|disallowed|non-?covered)\s*(?:amount|charge)?[:\s]*\$\s*([\d,]+\.?\d{0,2})/i,
  /\$\s*([\d,]+\.?\d{0,2})\s*(?:denied|not\s*covered|adjusted|disallowed)/i,
  /(?:Amount\s*Denied|Denied\s*Amount|Adjustment\s*Amount|Non-?Covered\s*Amount)\s*[:\-]?\s*\$?\s*([\d,]+\.?\d{0,2})/i,
  /(?:Total\s*Charges?\s*Denied|Billed\s*Amount)\s*[:\-]?\s*\$?\s*([\d,]+\.?\d{0,2})/i,
];

const DENIAL_REASON_PATTERNS = [
  /(?:Reason\s*for\s*Denial|Denial\s*Reason|Reason\s*Code|Denial\s*Code)\s*[:\-]?\s*(.{5,500})/i,
  /(?:This\s*claim\s*(?:was|has\s*been)\s*denied\s*(?:because|due\s*to|for))\s*(.{5,500})/i,
  /(?:Not\s*covered\s*(?:because|due\s*to)|Services?\s*(?:is|are)\s*not\s*(?:medically\s*necessary|covered))\s*(.{5,300})/i,
];

// ─── Textract Client ────────────────────────────────────────────────────────

let textractClient: TextractClient | null = null;

function getTextractClient(): TextractClient {
  if (!textractClient) {
    textractClient = new TextractClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return textractClient;
}

/**
 * Allows injecting a mock Textract client for testing.
 */
export function setTextractClient(client: TextractClient): void {
  textractClient = client;
}

/**
 * Resets the Textract client (useful for testing cleanup).
 */
export function resetTextractClient(): void {
  textractClient = null;
}

// ─── Core Processing Functions ──────────────────────────────────────────────

/**
 * Processes a document through Textract and extracts Denial_Record fields.
 *
 * @param input - Document location and format information
 * @returns TextractExtractionResult with extracted fields and confidence indicators
 */
export async function processDocument(
  input: TextractProcessorInput
): Promise<TextractExtractionResult> {
  const client = getTextractClient();

  const commandInput = buildAnalyzeDocumentInput(input);
  const command = new AnalyzeDocumentCommand(commandInput);
  const response = await client.send(command);

  const blocks = response.Blocks || [];
  const { text, pageCount } = extractTextFromBlocks(blocks);

  if (text.trim().length === 0) {
    return buildEmptyResult();
  }

  return extractFieldsFromText(text, pageCount);
}

/**
 * Builds the AnalyzeDocument API input based on document format and location.
 */
export function buildAnalyzeDocumentInput(
  input: TextractProcessorInput
): AnalyzeDocumentCommandInput {
  const featureTypes = ['FORMS', 'TABLES'] as const;

  if (input.documentBytes) {
    // For image formats (TIFF, PNG, JPEG) or when bytes are provided directly
    return {
      Document: {
        Bytes: input.documentBytes,
      },
      FeatureTypes: [...featureTypes],
    };
  }

  // For S3-based documents (PDF and images stored in S3)
  return {
    Document: {
      S3Object: {
        Bucket: input.s3Bucket,
        Name: input.s3Key,
      },
    },
    FeatureTypes: [...featureTypes],
  };
}

/**
 * Extracts concatenated text content from Textract response blocks.
 * Only processes LINE-type blocks to get readable text.
 */
export function extractTextFromBlocks(blocks: Block[]): { text: string; pageCount: number } {
  const pages = new Set<number>();
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.BlockType === 'LINE' && block.Text) {
      lines.push(block.Text);
      if (block.Page) {
        pages.add(block.Page);
      }
    }
  }

  return {
    text: lines.join('\n'),
    pageCount: pages.size || 1,
  };
}

/**
 * Applies regex patterns to extracted text to identify Denial_Record fields.
 */
export function extractFieldsFromText(
  text: string,
  pageCount: number
): TextractExtractionResult {
  return {
    claim_id: extractClaimId(text),
    patient_id: extractPatientId(text),
    payer_id: extractPayerId(text),
    denial_date: extractDenialDate(text),
    denied_amount: extractDeniedAmount(text),
    denial_reason: extractDenialReason(text),
    raw_text: text,
    page_count: pageCount,
    extraction_timestamp: new Date().toISOString(),
  };
}

// ─── Field Extraction Functions ─────────────────────────────────────────────

/**
 * Extracts claim ID from document text using multiple patterns.
 */
export function extractClaimId(text: string): ExtractedFieldResult<string> {
  for (const pattern of CLAIM_ID_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim();
      return {
        value,
        confidence: 'high',
        rawMatch: match[0],
      };
    }
  }
  return { value: null, confidence: 'low', rawMatch: null };
}

/**
 * Extracts patient/member ID from document text.
 */
export function extractPatientId(text: string): ExtractedFieldResult<string> {
  for (const pattern of PATIENT_ID_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim();
      return {
        value,
        confidence: 'high',
        rawMatch: match[0],
      };
    }
  }
  return { value: null, confidence: 'low', rawMatch: null };
}

/**
 * Extracts payer name or ID from document text.
 */
export function extractPayerId(text: string): ExtractedFieldResult<string> {
  for (const pattern of PAYER_ID_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim();
      // Truncate overly long matches (likely captured too much)
      const truncated = value.length > 60 ? value.substring(0, 60).trim() : value;
      return {
        value: truncated,
        confidence: value.length <= 30 ? 'high' : 'medium',
        rawMatch: match[0],
      };
    }
  }
  return { value: null, confidence: 'low', rawMatch: null };
}

/**
 * Extracts denial date from document text and normalizes to ISO 8601.
 */
export function extractDenialDate(text: string): ExtractedFieldResult<string> {
  for (const pattern of DENIAL_DATE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const rawDate = match[1].trim();
      const isoDate = normalizeDateToISO8601(rawDate);
      if (isoDate && isValidISO8601(isoDate)) {
        return {
          value: isoDate,
          confidence: 'high',
          rawMatch: match[0],
        };
      }
      // Date matched but couldn't normalize — medium confidence with raw value
      return {
        value: null,
        confidence: 'medium',
        rawMatch: match[0],
      };
    }
  }
  return { value: null, confidence: 'low', rawMatch: null };
}

/**
 * Extracts denied amount from document text.
 */
export function extractDeniedAmount(text: string): ExtractedFieldResult<number> {
  for (const pattern of DENIED_AMOUNT_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const rawAmount = match[1].replace(/,/g, '');
      const amount = parseFloat(rawAmount);
      if (!isNaN(amount) && isFinite(amount) && amount >= 0) {
        const rounded = roundToUSD(amount);
        if (isValidUSDAmount(rounded)) {
          return {
            value: rounded,
            confidence: 'high',
            rawMatch: match[0],
          };
        }
      }
    }
  }
  return { value: null, confidence: 'low', rawMatch: null };
}

/**
 * Extracts denial reason text from document.
 */
export function extractDenialReason(text: string): ExtractedFieldResult<string> {
  for (const pattern of DENIAL_REASON_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let reason = match[1].trim();
      // Clean up: stop at sentence boundaries or double newlines
      const sentenceEnd = reason.search(/(?:\.\s|\n\n)/);
      if (sentenceEnd > 10) {
        reason = reason.substring(0, sentenceEnd + 1).trim();
      }
      // Cap at reasonable length
      if (reason.length > 500) {
        reason = reason.substring(0, 500).trim();
      }
      return {
        value: reason,
        confidence: reason.length > 20 ? 'high' : 'medium',
        rawMatch: match[0],
      };
    }
  }
  return { value: null, confidence: 'low', rawMatch: null };
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Normalizes various date formats to ISO 8601 (YYYY-MM-DD).
 */
export function normalizeDateToISO8601(dateStr: string): string | null {
  // Try MM/DD/YYYY or MM-DD-YYYY
  const mdyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mdyMatch) {
    const month = mdyMatch[1].padStart(2, '0');
    const day = mdyMatch[2].padStart(2, '0');
    const year = mdyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // Try MM/DD/YY or MM-DD-YY
  const mdyShortMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (mdyShortMatch) {
    const month = mdyShortMatch[1].padStart(2, '0');
    const day = mdyShortMatch[2].padStart(2, '0');
    const yearShort = parseInt(mdyShortMatch[3], 10);
    const year = yearShort >= 50 ? `19${mdyShortMatch[3]}` : `20${mdyShortMatch[3]}`;
    return `${year}-${month}-${day}`;
  }

  // Try YYYY/MM/DD or YYYY-MM-DD
  const ymdMatch = dateStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Try "Month DD, YYYY" or "Month DD YYYY"
  const namedMonthMatch = dateStr.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})$/i
  );
  if (namedMonthMatch) {
    const monthNames: Record<string, string> = {
      january: '01', february: '02', march: '03', april: '04',
      may: '05', june: '06', july: '07', august: '08',
      september: '09', october: '10', november: '11', december: '12',
    };
    const month = monthNames[namedMonthMatch[1].toLowerCase()];
    const day = namedMonthMatch[2].padStart(2, '0');
    const year = namedMonthMatch[3];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

/**
 * Builds an empty extraction result for documents with no extractable text.
 */
function buildEmptyResult(): TextractExtractionResult {
  const emptyField = <T>(): ExtractedFieldResult<T> => ({
    value: null,
    confidence: 'low',
    rawMatch: null,
  });

  return {
    claim_id: emptyField<string>(),
    patient_id: emptyField<string>(),
    payer_id: emptyField<string>(),
    denial_date: emptyField<string>(),
    denied_amount: emptyField<number>(),
    denial_reason: emptyField<string>(),
    raw_text: '',
    page_count: 0,
    extraction_timestamp: new Date().toISOString(),
  };
}
