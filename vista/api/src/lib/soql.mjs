// Every Salesforce read Vista makes, in one place, so `checkSalesforce` (lib/sfcheck.mjs) runs exactly the
// queries the app runs. Add a query here, never inline, and give it sample arguments in SAMPLES below.
import { lit, inList } from './salesforce.mjs';

export const SA_FIELDS = `Id, AppointmentNumber, Status, SchedStartTime, SchedEndTime, ActualStartTime, SS_Service_Appointment_Type__c,
  PulseM_Bio_Sent__c, SMS_Opt_out__c, Work_Order__c, Job__c,
  (SELECT ServiceResourceId, ServiceResource.Name, ServiceResource.AccountId, ServiceResource.Account.Name, Lead_Installer__c FROM ServiceResources)`;
export const WO_FIELDS = `Id, WorkOrderNumber, Subject, Status, Priority, Street, City, State, PostalCode, Latitude, Longitude, Description, CaseId, AccountId, ContactId,
  RecordType.Name, Account.Name, Contact.Phone, Contact.MobilePhone, WorkType.Name, Work_Type_Name__c, Job_Number__c,
  Job_Number__r.Name, Job_Number__r.Sales_Price__c, Job_Number__r.Total_SA_Expense_Labor__c, Job_Number__r.Product_type__c,
  Job_Number__r.Office__c, Job_Number__r.Office__r.Name, Job_Number__r.Production_Manager__c,
  Job_Number__r.Production_Manager__r.Name, Job_Number__r.Production_Manager__r.MobilePhone,
  (SELECT Id, LineItemNumber, Description, Quantity, Status FROM WorkOrderLineItems ORDER BY LineItemNumber)`;
export const EXPENSE_FIELDS = `Id, Name, CreatedDate, Date__c, Type__c, Status__c, Amount__c, Work_Order__c, Job__c, Service_Appointment__c,
  Did_you_complete_the_job_or_service__c, Additional_Work_Performed__c, Description_of_Work_Performed__c,
  Additional_Work_Performed_Description__c, Approver__c, TEST_SA__c, Paycheck_Period__c, Payable_Invoice_New__c`;
const WINDOW = 'SchedStartTime >= YESTERDAY AND SchedStartTime <= NEXT_N_DAYS:7';

export const SOQL = {
  // people.mjs: who a phone number belongs to
  resourcesOfUser: userId => `SELECT Id, Name, AccountId, Account.Name FROM ServiceResource WHERE RelatedRecordId = ${lit(userId)} AND IsActive = true`,
  pmOpenJob: userId => `SELECT Id FROM Job__c WHERE Production_Manager__c = ${lit(userId)} AND Is_Open__c = true LIMIT 1`,
  recentVisitTypes: resourceIds => `SELECT ServiceAppointment.SS_Service_Appointment_Type__c FROM AssignedResource WHERE ServiceResourceId IN ${inList(resourceIds)} AND ServiceAppointment.SchedStartTime = LAST_N_DAYS:60 LIMIT 50`,
  // snapshot.mjs: one person's jobs
  pmVisits: userId => `SELECT ${SA_FIELDS} FROM ServiceAppointment WHERE Work_Order__r.Job_Number__r.Production_Manager__c = ${lit(userId)} AND ${WINDOW} AND Test_SA__c = false`,
  crewAssignments: resourceIds => `SELECT ServiceAppointmentId FROM AssignedResource WHERE ServiceResourceId IN ${inList(resourceIds)} AND ServiceAppointment.SchedStartTime >= YESTERDAY AND ServiceAppointment.SchedStartTime <= NEXT_N_DAYS:7`,
  visitsById: ids => `SELECT ${SA_FIELDS} FROM ServiceAppointment WHERE Id IN ${inList(ids)} AND Test_SA__c = false`,
  workOrders: ids => `SELECT ${WO_FIELDS} FROM WorkOrder WHERE Id IN ${inList(ids)}`,
  expensesForWorkOrders: ids => `SELECT ${EXPENSE_FIELDS} FROM SA_Expense__c WHERE Work_Order__c IN ${inList(ids)} AND TEST_SA__c = false ORDER BY CreatedDate DESC`,
  openCases: jobIds => `SELECT Id, CaseNumber, Subject, Status, CreatedDate, Job__c, Work_Type__c, Service_Type__c, Warranty_Type__c, Priority, Description FROM Case WHERE Job__c IN ${inList(jobIds)} AND IsClosed = false`,
  // services.mjs: scheduled jobs and payroll's board
  cutoffPending: () => `SELECT ${EXPENSE_FIELDS}, Work_Order__r.WorkOrderNumber, Work_Order__r.Account.Name, Service_Appointment__r.SMS_Opt_out__c
      FROM SA_Expense__c WHERE Type__c = 'Vista' AND Status__c = 'New' AND TEST_SA__c = false AND Did_you_complete_the_job_or_service__c = 'Yes'`,
  assignedForVisits: visitIds => `SELECT ServiceAppointmentId, ServiceResourceId, Lead_Installer__c FROM AssignedResource WHERE ServiceAppointmentId IN ${inList(visitIds)}`,
  dispatchedSince: sinceIso => `SELECT Id, SchedStartTime, Work_Order__r.Account.Name, Work_Order__r.Street, Work_Order__r.Job_Number__r.Office__c, Work_Order__r.Job_Number__r.Office__r.Name, (SELECT ServiceResourceId FROM ServiceResources)
      FROM ServiceAppointment WHERE Status = 'Dispatched' AND LastModifiedDate > ${sinceIso.replace(/\.\d+Z$/, 'Z')} AND Test_SA__c = false`,
  heartbeatTestWorkOrder: () => `SELECT Id FROM WorkOrder WHERE Test_WO__c = true ORDER BY LastModifiedDate DESC LIMIT 1`,
  heartbeatAnyWorkOrder: () => `SELECT Id FROM WorkOrder ORDER BY LastModifiedDate DESC LIMIT 1`,
  board: () => `SELECT ${EXPENSE_FIELDS}, Production_Manager__c, Production_Manager__r.Name, Account__r.Name,
      Work_Order__r.WorkOrderNumber, Work_Order__r.Account.Name, Work_Order__r.Job_Number__r.Office__r.Name
      FROM SA_Expense__c WHERE Type__c = 'Vista' AND TEST_SA__c = false AND (Status__c = 'New' OR CreatedDate = LAST_N_DAYS:30)
      ORDER BY CreatedDate DESC LIMIT 500`
};

// SOSL: people.mjs finds a User by the phone number that texted or signed in.
export const SOSL = {
  userByPhone: digits => `FIND {${digits}} IN PHONE FIELDS RETURNING User(Id, Name, MobilePhone, LanguageLocaleKey WHERE IsActive = true)`
};

// What each read is for, in the Check Salesforce report.
export const PURPOSE = {
  userByPhone: 'Sign-in: find a person by phone', resourcesOfUser: 'Sign-in: their crew record', pmOpenJob: 'Sign-in: are they a PM',
  recentVisitTypes: 'Sign-in: measure tech or installer', pmVisits: "A PM's visits", crewAssignments: "A crew's assigned visits",
  visitsById: 'Visit details', workOrders: 'Job details and line items', expensesForWorkOrders: 'Pay requests on a job',
  openCases: 'Open problems on a job', cutoffPending: '10 AM cutoff: pay still waiting', assignedForVisits: 'Crews on a visit',
  dispatchedSince: 'Newly dispatched visits', heartbeatTestWorkOrder: 'Health check: read a test job', heartbeatAnyWorkOrder: 'Health check: read a job',
  board: "Payroll's pay run board"
};

// Arguments the check uses: well-formed Ids that match nothing, so each query is fully checked and returns nothing.
const NO_ID = '000000000000000AAA';
export const SAMPLES = {
  resourcesOfUser: [NO_ID], pmOpenJob: [NO_ID], recentVisitTypes: [[NO_ID]], pmVisits: [NO_ID], crewAssignments: [[NO_ID]],
  visitsById: [[NO_ID]], workOrders: [[NO_ID]], expensesForWorkOrders: [[NO_ID]], openCases: [[NO_ID]],
  cutoffPending: [], assignedForVisits: [[NO_ID]], dispatchedSince: [new Date(Date.now() - 10 * 60e3).toISOString()],
  heartbeatTestWorkOrder: [], heartbeatAnyWorkOrder: [], board: [], userByPhone: ['0000000000']
};
