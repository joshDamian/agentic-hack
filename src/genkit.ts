import { genkit } from 'genkit/beta';
import { vertexAI } from '@genkit-ai/google-genai';
import { config } from './shared/config.js';

export const ai = genkit({
  plugins: [
    vertexAI({
      projectId: config.gcpProject,
      location: config.gcpLocation,
    }),
  ],
  model: vertexAI.model(config.extractionModel),
});
