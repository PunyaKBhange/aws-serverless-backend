// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CodeDeploy, Lambda, DynamoDB } from 'aws-sdk';

const cdClient = new CodeDeploy({ apiVersion: '2014-10-06' });
const lambdaClient = new Lambda();
const ddbClient = new DynamoDB({ apiVersion: '2012-08-10' });

const tableName = process.env.TABLE || 'books';

/**
 * CodeDeploy Pre-Traffic Hook: CreateBook Deployment Validation
 * 
 * Purpose:
 * This Lambda function acts as a deployment safety gate for the CreateBook function.
 * It runs BEFORE any production traffic is shifted to the new Lambda version.
 * 
 * Deployment Flow (Production Only):
 * 1. New version of CreateBook Lambda is deployed
 * 2. CodeDeploy invokes THIS pre-traffic hook
 * 3. Hook performs smoke test on new version
 * 4. If test passes → CodeDeploy gradually shifts traffic (Linear10PercentEvery1Minute)
 * 5. If test fails → Deployment is aborted, traffic stays on old version
 * 
 * Smoke Test Strategy:
 * - Invokes the NEW version of CreateBook Lambda directly
 * - Passes test book data
 * - Verifies book was written to DynamoDB
 * - Cleans up test data
 * - Reports success/failure to CodeDeploy
 * 
 * Why This Matters:
 * - Prevents broken code from reaching production users
 * - Validates integration with DynamoDB before traffic shift
 * - Catches deployment issues early (permissions, configuration, etc.)
 * - Part of AWS Well-Architected Framework: Operational Excellence pillar
 * 
 * IAM Permissions Required:
 * - lambda:InvokeFunction - To test the new Lambda version
 * - dynamodb:GetItem, PutItem, DeleteItem - To verify and cleanup test data
 * - codedeploy:PutLifecycleEventHookExecutionStatus - To report results to CodeDeploy
 * 
 * Observability:
 * - CloudWatch Logs: Detailed logging of test execution
 * - CodeDeploy Console: Shows hook execution status
 * - If hook fails, deployment is marked as failed in CodeDeploy
 */
export const handler = async (event: any) => {
    console.log('[PreTrafficHook] Starting deployment validation');
    console.log('[PreTrafficHook] CodeDeploy event:', JSON.stringify(event, null, 2));

    let status = 'Succeeded';
    try {
        const functionToTest = process.env.FN_NEW_VERSION || 'books-create';
        console.log(`[PreTrafficHook] Testing new Lambda version: ${functionToTest}`);

        // Prepare test book data for smoke test
        const book = {
            isbn: '1-111-111-111',
            title: 'Smoke Test',
            year: '1111',
            author: 'Test',
            publisher: 'Test',
            rating: 1,
            pages: 111
        };

        const request = {
            body: JSON.stringify(book)
        };

        console.log('[PreTrafficHook] Invoking new Lambda version with test data');

        // Invoke the NEW version of CreateBook Lambda
        // This tests if the new code can successfully process a request
        const lParams: Lambda.Types.InvocationRequest = {
            FunctionName: functionToTest,
            Payload: JSON.stringify(request)
        };
        await lambdaClient.invoke(lParams).promise();

        console.log('[PreTrafficHook] Lambda invocation successful, verifying DynamoDB write');

        // Verify the test book was written to DynamoDB
        // This validates end-to-end integration
        const ddbParams: DynamoDB.Types.GetItemInput = {
            TableName: tableName,
            Key: { isbn: { S: book.isbn } },
            ConsistentRead: true  // Ensures we read the latest data
        };

        console.log('[PreTrafficHook] DynamoDB getItem params:', JSON.stringify(ddbParams, null, 2));

        // Wait briefly to ensure DynamoDB write has propagated
        await wait();

        const { Item } = await ddbClient.getItem(ddbParams).promise();
        console.log('[PreTrafficHook] DynamoDB item retrieved:', JSON.stringify(Item, null, 2));

        if (!Item) {
            throw new Error('Test book not inserted in DynamoDB - deployment validation failed');
        }

        console.log('[PreTrafficHook] Validation successful, cleaning up test data');

        // Clean up: Delete test book from DynamoDB
        delete ddbParams.ConsistentRead;
        await ddbClient.deleteItem(ddbParams).promise();
        console.log('[PreTrafficHook] Test data cleaned up successfully');

    } catch (e) {
        console.error('[PreTrafficHook] Validation failed:', e);
        status = 'Failed';
        // When status is 'Failed', CodeDeploy will abort the deployment
        // Traffic will NOT be shifted to the new version
    }

    // Report hook execution status back to CodeDeploy
    // This determines whether deployment proceeds or is aborted
    const cdParams: CodeDeploy.Types.PutLifecycleEventHookExecutionStatusInput = {
        deploymentId: event.DeploymentId,
        lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
        status  // 'Succeeded' or 'Failed'
    };

    console.log(`[PreTrafficHook] Reporting status to CodeDeploy: ${status}`);
    return await cdClient.putLifecycleEventHookExecutionStatus(cdParams).promise();
};

/**
 * Helper function: Wait for DynamoDB eventual consistency
 * Ensures test data is available before validation
 */
function wait(ms?: number) {
    const t = ms || 1500;
    return new Promise(resolve => {
        setTimeout(resolve, t);
    });
}