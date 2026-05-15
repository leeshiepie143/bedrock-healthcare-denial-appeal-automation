#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DenialAppealAgentStack } from '../infra/stacks/denial-appeal-agent-stack';

const app = new cdk.App();

new DenialAppealAgentStack(app, 'DenialAppealAgentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Revenue Cycle Denial Appeal Agent - Core Infrastructure',
});

app.synth();
