/**
 * EDI 835/277 Parser Lambda
 *
 * Parses EDI 835 (Health Care Claim Payment/Advice) and EDI 277 (Claim Status Response)
 * transactions to extract denial-related fields into standardized Denial_Record format.
 *
 * Key segments parsed:
 * - EDI 835: ISA, GS, ST, CLP, CAS, DTM, N1
 * - EDI 277: ISA, GS, ST, TRN, STC, REF
 *
 * Delimiters: segment `~`, element `*`, sub-element `:`
 */

import type { SourceFormat } from '@shared/models';
import { buildTenantPK, buildDenialSK, TABLE_DENIAL_APPEALS } from '@shared/dynamodb';
import { isValidISO8601, isValidUSDAmount, isNonEmptyString } from '@shared/validation';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum file size in bytes (50 MB) */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Maximum page count (100 pages — for EDI, we treat each ST/SE envelope as a "page") */
export const MAX_PAGE_COUNT = 100;

/** Default delimiters for X12 EDI */
const DEFAULT_SEGMENT_DELIMITER = '~';
const DEFAULT_ELEMENT_DELIMITER = '*';
const DEFAULT_SUB_ELEMENT_DELIMITER = ':';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EDI835ParsedFields {
  claim_id: string | null;
  patient_id: string | null;
  payer_id: string | null;
  denial_date: string | null;
  denied_amount: number | null;
  adjustment_reason_codes: AdjustmentReasonCode[];
  raw_denial_reason_text: string | null;
}

export interface EDI277ParsedFields {
  claim_id: string | null;
  status_category_code: string | null;
  status_code: string | null;
  payer_id: string | null;
  patient_id: string | null;
  raw_denial_reason_text: string | null;
}

export interface AdjustmentReasonCode {
  group_code: string;
  reason_code: string;
  amount: number;
}

export interface EDIParseResult {
  success: boolean;
  source_format: SourceFormat;
  fields: EDI835ParsedFields | EDI277ParsedFields;
  errors: string[];
  transaction_count: number;
}

export interface DeduplicationResult {
  isDuplicate: boolean;
  existingRecordKey?: { PK: string; SK: string };
}

export interface FileSizeValidationResult {
  valid: boolean;
  error?: string;
  fileSize: number;
  transactionCount: number;
}

// ─── File Size and Page Count Validation ────────────────────────────────────

/**
 * Validates file size and transaction (page) count limits.
 * For EDI files, each ST/SE transaction set envelope counts as one "page".
 */
export function validateFileLimits(content: string): FileSizeValidationResult {
  const fileSize = Buffer.byteLength(content, 'utf-8');
  const transactionCount = countTransactionSets(content);

  if (fileSize > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File size ${fileSize} bytes exceeds maximum of ${MAX_FILE_SIZE_BYTES} bytes (50 MB)`,
      fileSize,
      transactionCount,
    };
  }

  if (transactionCount > MAX_PAGE_COUNT) {
    return {
      valid: false,
      error: `Transaction count ${transactionCount} exceeds maximum of ${MAX_PAGE_COUNT}`,
      fileSize,
      transactionCount,
    };
  }

  return { valid: true, fileSize, transactionCount };
}

/**
 * Counts the number of ST (Transaction Set Header) segments in the EDI content.
 */
function countTransactionSets(content: string): number {
  const segments = splitSegments(content);
  return segments.filter((seg) => seg.startsWith('ST')).length;
}

// ─── EDI Segment Parsing Utilities ──────────────────────────────────────────

/**
 * Detects delimiters from the ISA segment.
 * ISA is always exactly 106 characters. Position 3 is element delimiter,
 * position 104 is sub-element delimiter, and the character after position 105
 * is the segment terminator.
 */
export function detectDelimiters(content: string): {
  segment: string;
  element: string;
  subElement: string;
} {
  const trimmed = content.trimStart();

  if (trimmed.startsWith('ISA') && trimmed.length >= 106) {
    const elementDelimiter = trimmed[3];
    const subElementDelimiter = trimmed[104];
    const segmentDelimiter = trimmed[105];

    return {
      segment: segmentDelimiter,
      element: elementDelimiter,
      subElement: subElementDelimiter,
    };
  }

  return {
    segment: DEFAULT_SEGMENT_DELIMITER,
    element: DEFAULT_ELEMENT_DELIMITER,
    subElement: DEFAULT_SUB_ELEMENT_DELIMITER,
  };
}

/**
 * Splits EDI content into individual segments, trimming whitespace.
 */
export function splitSegments(content: string, segmentDelimiter?: string): string[] {
  const delimiter = segmentDelimiter || detectDelimiters(content).segment;
  return content
    .split(delimiter)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

/**
 * Splits a segment into its elements.
 */
export function splitElements(segment: string, elementDelimiter?: string): string[] {
  const delimiter = elementDelimiter || DEFAULT_ELEMENT_DELIMITER;
  return segment.split(delimiter);
}

/**
 * Splits a sub-element composite value.
 */
export function splitSubElements(element: string, subElementDelimiter?: string): string[] {
  const delimiter = subElementDelimiter || DEFAULT_SUB_ELEMENT_DELIMITER;
  return element.split(delimiter);
}

// ─── EDI Format Detection ───────────────────────────────────────────────────

/**
 * Detects whether the EDI content is an 835 or 277 transaction.
 * Returns the source format or null if unrecognized.
 */
export function detectEDIFormat(content: string): SourceFormat | null {
  const segments = splitSegments(content);

  for (const segment of segments) {
    const elements = splitElements(segment);
    if (elements[0] === 'ST') {
      const transactionSetId = elements[1];
      if (transactionSetId === '835') return 'edi_835';
      if (transactionSetId === '277') return 'edi_277';
    }
  }

  return null;
}

// ─── EDI 835 Parser ─────────────────────────────────────────────────────────

/**
 * Parses an EDI 835 (Health Care Claim Payment/Advice) transaction.
 *
 * Extracts:
 * - claim_id from CLP01
 * - patient_id from CLP07
 * - payer_id from N1*PR segment (N104)
 * - denial_date from DTM*232 (claim statement period start)
 * - denied_amount: charged_amount (CLP03) - paid_amount (CLP04)
 * - adjustment_reason_codes from CAS segments
 */
export function parseEDI835(content: string): EDI835ParsedFields {
  const delimiters = detectDelimiters(content);
  const segments = splitSegments(content, delimiters.segment);

  let claim_id: string | null = null;
  let patient_id: string | null = null;
  let payer_id: string | null = null;
  let denial_date: string | null = null;
  let denied_amount: number | null = null;
  const adjustment_reason_codes: AdjustmentReasonCode[] = [];

  let inPayerLoop = false;

  for (const segment of segments) {
    const elements = splitElements(segment, delimiters.element);
    const segmentId = elements[0];

    switch (segmentId) {
      case 'N1': {
        // N1*PR = Payer identification
        if (elements[1] === 'PR') {
          inPayerLoop = true;
          // N104 is the payer identification code
          if (elements.length > 3 && elements[4]) {
            payer_id = elements[4];
          } else if (elements.length > 1 && elements[2]) {
            // Fallback to payer name if no ID code
            payer_id = elements[2];
          }
        } else {
          inPayerLoop = false;
        }
        break;
      }

      case 'CLP': {
        // CLP01: Patient's Claim Number (claim_id)
        // CLP02: Claim Status Code
        // CLP03: Total Claim Charge Amount
        // CLP04: Total Claim Payment Amount
        // CLP07: Patient Account Number (patient_id)
        if (elements[1]) {
          claim_id = elements[1];
        }
        if (elements.length > 6 && elements[7]) {
          patient_id = elements[7];
        }
        // denied_amount = charged - paid
        const chargedAmount = parseFloat(elements[3] || '0');
        const paidAmount = parseFloat(elements[4] || '0');
        if (!isNaN(chargedAmount) && !isNaN(paidAmount)) {
          const rawDenied = chargedAmount - paidAmount;
          denied_amount = Math.round(rawDenied * 100) / 100;
        }
        break;
      }

      case 'CAS': {
        // CAS segments contain adjustment reason codes
        // CAS01: Claim Adjustment Group Code (CO, PR, OA, PI, CR)
        // Standard positions (1-indexed in X12 spec):
        //   CAS02: Reason Code 1, CAS03: Amount 1, CAS04: Quantity 1 (optional)
        //   CAS05: Reason Code 2, CAS06: Amount 2, CAS07: Quantity 2 (optional)
        //   ... up to 6 adjustment groups per CAS segment
        //
        // In practice, many implementations omit the quantity field entirely,
        // resulting in (reason, amount) pairs instead of (reason, amount, quantity) triplets.
        // We detect the stride by checking if the data element count is divisible by 3.
        const groupCode = elements[1] || '';
        const dataElements = elements.slice(2); // everything after group code

        // Determine stride: if divisible by 3 and has quantity-like values, use 3; otherwise 2
        const stride = (dataElements.length % 3 === 0 && dataElements.length >= 3) ? 3 : 2;

        for (let i = 0; i < dataElements.length; i += stride) {
          const reasonCode = dataElements[i];
          const amountStr = dataElements[i + 1];
          const amount = parseFloat(amountStr || '0');

          if (reasonCode && reasonCode.trim() && reasonCode.trim() !== '') {
            adjustment_reason_codes.push({
              group_code: groupCode,
              reason_code: reasonCode.trim(),
              amount: isNaN(amount) ? 0 : Math.round(amount * 100) / 100,
            });
          }
        }
        break;
      }

      case 'DTM': {
        // DTM*232 = Claim Statement Period Start
        // DTM01: Date/Time Qualifier
        // DTM02: Date (CCYYMMDD format)
        if (elements[1] === '232' && elements[2]) {
          denial_date = convertEDIDate(elements[2]);
        }
        break;
      }
    }
  }

  // Build raw denial reason text from adjustment codes
  const raw_denial_reason_text = adjustment_reason_codes.length > 0
    ? adjustment_reason_codes
        .map((arc) => `${arc.group_code}-${arc.reason_code}: $${arc.amount.toFixed(2)}`)
        .join('; ')
    : null;

  return {
    claim_id,
    patient_id,
    payer_id,
    denial_date,
    denied_amount,
    adjustment_reason_codes,
    raw_denial_reason_text,
  };
}

// ─── EDI 277 Parser ─────────────────────────────────────────────────────────

/**
 * Parses an EDI 277 (Claim Status Response) transaction.
 *
 * Extracts:
 * - claim_id from TRN02 or REF*EJ segment
 * - status_category_code from STC01-1 (first sub-element)
 * - status_code from STC01-2 (second sub-element)
 * - payer_id from N1*PR segment
 * - patient_id from N1*IL or NM1*IL segment
 */
export function parseEDI277(content: string): EDI277ParsedFields {
  const delimiters = detectDelimiters(content);
  const segments = splitSegments(content, delimiters.segment);

  let claim_id: string | null = null;
  let status_category_code: string | null = null;
  let status_code: string | null = null;
  let payer_id: string | null = null;
  let patient_id: string | null = null;

  for (const segment of segments) {
    const elements = splitElements(segment, delimiters.element);
    const segmentId = elements[0];

    switch (segmentId) {
      case 'TRN': {
        // TRN02: Reference Identification (claim tracking number)
        if (elements[2] && !claim_id) {
          claim_id = elements[2];
        }
        break;
      }

      case 'REF': {
        // REF*EJ = Patient Account Number (can serve as claim_id)
        // REF*D9 = Claim Identifier
        if ((elements[1] === 'EJ' || elements[1] === 'D9') && elements[2]) {
          claim_id = elements[2];
        }
        break;
      }

      case 'STC': {
        // STC01 is a composite element: status_category_code:status_code:entity_code
        if (elements[1]) {
          const subElements = splitSubElements(elements[1], delimiters.subElement);
          if (subElements[0]) {
            status_category_code = subElements[0];
          }
          if (subElements[1]) {
            status_code = subElements[1];
          }
        }
        break;
      }

      case 'N1': {
        // N1*PR = Payer
        // N1*IL = Insured/Subscriber
        if (elements[1] === 'PR' && elements.length > 3) {
          payer_id = elements[4] || elements[2] || null;
        }
        if (elements[1] === 'IL' && elements.length > 3) {
          patient_id = elements[4] || elements[2] || null;
        }
        break;
      }

      case 'NM1': {
        // NM1*IL = Insured/Subscriber
        // NM1*PR = Payer
        if (elements[1] === 'IL' && elements.length > 8) {
          patient_id = elements[9] || null;
        }
        if (elements[1] === 'PR' && elements.length > 8) {
          payer_id = elements[9] || null;
        }
        break;
      }
    }
  }

  // Build raw denial reason text from status codes
  const raw_denial_reason_text =
    status_category_code || status_code
      ? `Status Category: ${status_category_code || 'N/A'}, Status Code: ${status_code || 'N/A'}`
      : null;

  return {
    claim_id,
    status_category_code,
    status_code,
    payer_id,
    patient_id,
    raw_denial_reason_text,
  };
}

// ─── Date Conversion ────────────────────────────────────────────────────────

/**
 * Converts an EDI date (CCYYMMDD format) to ISO 8601 (YYYY-MM-DD).
 */
export function convertEDIDate(ediDate: string): string | null {
  if (!ediDate || ediDate.length !== 8) {
    return null;
  }

  const year = ediDate.substring(0, 4);
  const month = ediDate.substring(4, 6);
  const day = ediDate.substring(6, 8);

  const isoDate = `${year}-${month}-${day}`;

  if (isValidISO8601(isoDate)) {
    return isoDate;
  }

  return null;
}

// ─── Main Parse Function ────────────────────────────────────────────────────

/**
 * Main entry point for EDI parsing.
 * Detects format (835 vs 277), validates limits, and parses content.
 *
 * @param content - Raw EDI file content as a string
 * @returns EDIParseResult with parsed fields or errors
 */
export function parseEDI(content: string): EDIParseResult {
  const errors: string[] = [];

  // Validate file limits
  const limitCheck = validateFileLimits(content);
  if (!limitCheck.valid) {
    return {
      success: false,
      source_format: 'edi_835', // default, will be overridden if detectable
      fields: {
        claim_id: null,
        patient_id: null,
        payer_id: null,
        denial_date: null,
        denied_amount: null,
        adjustment_reason_codes: [],
        raw_denial_reason_text: null,
      },
      errors: [limitCheck.error!],
      transaction_count: limitCheck.transactionCount,
    };
  }

  // Detect format
  const format = detectEDIFormat(content);
  if (!format) {
    return {
      success: false,
      source_format: 'edi_835',
      fields: {
        claim_id: null,
        patient_id: null,
        payer_id: null,
        denial_date: null,
        denied_amount: null,
        adjustment_reason_codes: [],
        raw_denial_reason_text: null,
      },
      errors: ['Unable to detect EDI format. No ST segment with transaction set ID 835 or 277 found.'],
      transaction_count: limitCheck.transactionCount,
    };
  }

  // Parse based on format
  if (format === 'edi_835') {
    const fields = parseEDI835(content);

    // Validate mandatory fields
    if (!fields.claim_id) errors.push('claim_id not found in EDI 835 (CLP01)');
    if (!fields.payer_id) errors.push('payer_id not found in EDI 835 (N1*PR)');
    if (fields.denied_amount === null) errors.push('denied_amount could not be calculated from EDI 835 (CLP03-CLP04)');
    if (fields.adjustment_reason_codes.length === 0) errors.push('No adjustment reason codes found in EDI 835 (CAS segments)');

    return {
      success: errors.length === 0,
      source_format: 'edi_835',
      fields,
      errors,
      transaction_count: limitCheck.transactionCount,
    };
  } else {
    // EDI 277
    const fields = parseEDI277(content);

    // Validate key fields
    if (!fields.claim_id) errors.push('claim_id not found in EDI 277 (TRN02 or REF*EJ/D9)');
    if (!fields.status_category_code) errors.push('status_category_code not found in EDI 277 (STC01-1)');
    if (!fields.status_code) errors.push('status_code not found in EDI 277 (STC01-2)');

    return {
      success: errors.length === 0,
      source_format: 'edi_277',
      fields,
      errors,
      transaction_count: limitCheck.transactionCount,
    };
  }
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Checks if a denial record already exists in DynamoDB for the given
 * (claim_id, source_format) composite key within a tenant.
 *
 * This is a pure function that builds the query parameters.
 * The actual DynamoDB call is performed by the caller (ingestion handler).
 *
 * @param tenantId - The tenant identifier
 * @param claimId - The claim ID from the parsed EDI
 * @param sourceFormat - The source format (edi_835 or edi_277)
 * @returns The DynamoDB key to check for deduplication
 */
export function buildDeduplicationKey(
  tenantId: string,
  claimId: string,
  sourceFormat: SourceFormat
): { PK: string; SK: string; tableName: string } {
  return {
    PK: buildTenantPK(tenantId),
    SK: buildDenialSK(claimId, sourceFormat),
    tableName: TABLE_DENIAL_APPEALS,
  };
}

/**
 * Performs deduplication check against DynamoDB.
 * Returns whether a record with the same (claim_id, source_format) already exists.
 *
 * @param dynamoClient - DynamoDB Document Client instance
 * @param tenantId - The tenant identifier
 * @param claimId - The claim ID
 * @param sourceFormat - The source format
 */
export async function checkDuplicate(
  dynamoClient: { send: (command: unknown) => Promise<unknown> },
  tenantId: string,
  claimId: string,
  sourceFormat: SourceFormat
): Promise<DeduplicationResult> {
  const key = buildDeduplicationKey(tenantId, claimId, sourceFormat);

  try {
    // Use GetItem to check for existing record
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const command = new GetCommand({
      TableName: key.tableName,
      Key: { PK: key.PK, SK: key.SK },
      ProjectionExpression: 'PK, SK',
    });

    const response = await dynamoClient.send(command) as { Item?: { PK: string; SK: string } };

    if (response.Item) {
      return {
        isDuplicate: true,
        existingRecordKey: { PK: response.Item.PK, SK: response.Item.SK },
      };
    }

    return { isDuplicate: false };
  } catch (error) {
    // On error, assume not duplicate to avoid blocking ingestion
    // The caller should log this error
    console.error('Deduplication check failed:', error);
    return { isDuplicate: false };
  }
}
