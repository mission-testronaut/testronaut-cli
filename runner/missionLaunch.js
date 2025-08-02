import { mission, objective, launch } from './testronaut.js';
import { loginWorkflow } from '../workflows/loginWorkflow.js';
import { dashboardWorkflow } from '../workflows/dashboardWorkflow.js';

mission('Collegium Dashboard Login Test', () => {
  objective('should land on dashboard after login', dashboardWorkflow);
});

await launch(loginWorkflow); // Setup: login
