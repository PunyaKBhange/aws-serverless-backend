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
 * Lambda Handler: Create Book
 * 
 * Flow:
 * 1. API Gateway receives POST /books request with Authorization header
 * 2. API Gateway validates JWT token against Cognito User Pool (configured in template.yml)
 * 3. If authenticated, API Gateway invokes this Lambda with book data in event.body
 * 4. Lambda parses JSON payload and writes to DynamoDB
 * 5. Returns 201 Created on success, 500 on error
 * 
 * Authentication & Authorization:
 * - Requires valid Cognito access token with 'email' scope
 * - API Gateway performs authentication BEFORE invoking Lambda
 * - Lambda receives pre-authenticated requests (no token validation needed in code)
 * - This separation of concerns follows AWS best practices
 * 
 * IAM Permissions Required:
 * - dynamodb:PutItem on the Books table (granted via DynamoDBWritePolicy in template.yml)
 * - Follows least-privilege: write-only access, no read/delete permissions
 * 
 * DynamoDB Access Pattern:
 * - Uses PutItem operation (creates or overwrites item by primary key)
 * - Primary key: isbn (partition key)
 * - Note: No duplicate checking - same ISBN will overwrite existing book
 * 
 * Input Validation:
 * - Basic validation: Expects all required fields in request body
 * - Production consideration: Add schema validation (e.g., JSON Schema, Joi)
 * 
 * Observability:
 * - CloudWatch Logs: All console.log/error statements captured
 * - X-Ray Tracing: Captures DynamoDB write latency and API Gateway → Lambda flow
 * - CloudWatch Metrics: Lambda errors trigger alarms (configured in template.yml)
 * - CloudWatch Alarms: Deployment uses gradual rollout with automatic rollback on errors
 */
async function handler(event: any): Promise<APIGatewayProxyResult> {
  console.log('[CreateBook] Handler invoked');

  let response: APIGatewayProxyResult;
  try {
    // Initialize DynamoDB client
    // Security: SDK automatically uses IAM role attached to Lambda function
    const client = new AWS.DynamoDB(ddbOptions);

    // Parse incoming book data from API Gateway request body
    const book = JSON.parse(event.body);
    const { isbn, title, year, author, publisher, rating, pages } = book;

    console.log(`[CreateBook] Creating book with ISBN: ${isbn}`);

    const tableName = process.env.TABLE || 'books';

    // Prepare DynamoDB PutItem request
    // Note: DynamoDB requires type descriptors (S for String, N for Number)
    const params: AWS.DynamoDB.Types.PutItemInput = {
      TableName: tableName,
      Item: {
        isbn: { S: isbn },
        title: { S: title },
        year: { N: year.toString() },
        author: { S: author },
        publisher: { S: publisher },
        rating: { N: rating.toString() },
        pages: { N: pages.toString() }
      }
    };

    // Write to DynamoDB
    // Security: Encryption at rest enabled via SSESpecification in template.yml
    // Security: Encryption in transit via HTTPS (enforced by AWS SDK)
    await client.putItem(params).promise();

    console.log(`[CreateBook] Successfully created book: ${isbn} in table: ${tableName}`);

    response = {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: ''
    };

  } catch (e) {
    // Error handling: Log error details for CloudWatch investigation
    console.error('[CreateBook] Error occurred:', {
      error: e instanceof Error ? e.message : 'Unknown error',
      stack: e instanceof Error ? e.stack : undefined
    });

    // CloudWatch Metric: Lambda errors are automatically tracked
    // CloudWatch Alarm: Triggers on error threshold, can rollback deployment
    // CodeDeploy: Uses gradual traffic shift with automatic rollback on alarm

    response = {
      statusCode: 500,
      headers: {},
      body: ''
    };
  }
  return response;
}

export { handler };