/**
 * Shared module entry point.
 * Re-exports types, utilities, and constants used across Lambda functions.
 */

// Data model interfaces and type definitions
export * from './models';

// DynamoDB table schema, key builders, and GSI definitions
export * from './dynamodb';

// Validation utilities for dates, amounts, and enums
export * from './validation';

// Authentication, authorization, and tenant isolation middleware
export * from './auth-middleware';

// Audit logging middleware for PHI access tracking
export * from './audit-logger';
