// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { APIGatewayProxyResult } from 'aws-lambda';
import * as AWSCore from 'aws-sdk';
import * as AWSXRay from 'aws-xray-sdk-core';

let AWS;

const ddbOptions: AWSCore.DynamoDB.Types.ClientConfiguration = {
  apiVersion: '2012-08-10'
};

/**
 * Environment-aware AWS SDK initialization
 * - Local development: Uses standard AWS SDK pointing to local DynamoDB container
 * - AWS environment: Wraps SDK with X-Ray for distributed tracing
 * 
 * Security Note: X-Ray tracing helps monitor API performance and identify bottlenecks
 * without exposing sensitive data in traces
 */
if (process.env.AWS_SAM_LOCAL) {
  AWS = AWSCore;
  ddbOptions.endpoint = 'http://dynamodb:8000';
} else {
  AWS = AWSXRay.captureAWS(AWSCore);
}

/**
 * Lambda Handler: Get All Books
 * 
 * Flow:
 * 1. API Gateway receives GET /books request
 * 2. API Gateway invokes this Lambda function (no authentication required)
 * 3. Lambda performs DynamoDB Scan operation
 * 4. Results are transformed from DynamoDB format to JSON DTOs
 * 5. Response returned to API Gateway, then to client
 * 
 * IAM Permissions Required:
 * - dynamodb:Scan on the Books table (granted via DynamoDBReadPolicy in template.yml)
 * - This follows least-privilege principle: read-only access, no write permissions
 * 
 * DynamoDB Access Pattern:
 * - Uses Scan operation (reads entire table)
 * - Note: Scan is acceptable for small datasets or learning purposes
 * - Production consideration: For large tables, use Query with pagination or GSI
 * 
 * Observability:
 * - CloudWatch Logs: All console.log statements are captured
 * - X-Ray Tracing: Captures DynamoDB call latency and service map
 * - CloudWatch Metrics: Lambda duration, invocations, errors tracked automatically
 */
async function handler(): Promise<APIGatewayProxyResult> {
  console.log('[GetAllBooks] Handler invoked');

  let response: APIGatewayProxyResult;
  try {
    // Initialize DynamoDB client
    // Security: SDK automatically uses IAM role attached to Lambda function
    const client = new AWS.DynamoDB(ddbOptions);

    const tableName = process.env.TABLE || 'books';
    console.log(`[GetAllBooks] Scanning table: ${tableName}`);

    const params: AWS.DynamoDB.Types.ScanInput = {
      TableName: tableName
    };

    // Perform DynamoDB Scan
    // Note: This operation reads all items in the table
    const result: AWS.DynamoDB.Types.ScanOutput = await client.scan(params).promise();

    console.log(`[GetAllBooks] Retrieved ${result.Items?.length || 0} books from DynamoDB`);

    // Transform DynamoDB items to clean JSON objects
    // DynamoDB returns items with type descriptors (S for String, N for Number)
    const bookDtos = result.Items?.map(item => ({
      isbn: item['isbn'].S,
      title: item['title'].S,
      year: parseInt(item['year'].N!, 10),
      author: item['author'].S,
      publisher: item['publisher'].S,
      rating: parseInt(item['rating'].N!, 10),
      pages: parseInt(item['pages'].N!, 10)
    })) || [];

    response = {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookDtos)
    };

    console.log('[GetAllBooks] Successfully returning books');

  } catch (e) {
    // Error handling: Log error details for CloudWatch investigation
    console.error('[GetAllBooks] Error occurred:', {
      error: e instanceof Error ? e.message : 'Unknown error',
      stack: e instanceof Error ? e.stack : undefined
    });

    // CloudWatch Metric: Lambda errors are automatically tracked
    // CloudWatch Alarm: Can trigger based on error threshold (configured in template.yml)

    response = {
      statusCode: 500,
      headers: {},
      body: ''
    };
  }
  return response;
}

export { handler };