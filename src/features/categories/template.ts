export const householdTemplateVersion = 1;
export const householdTemplate = [
  ['income', 'Income', 'income', ['Salary', 'Bonus', 'Side Income', 'Rental Income', 'Interest', 'Other Income']],
  ['housing', 'Housing', 'expense', ['Bond/Rent', 'Property Rates', 'Levies', 'Maintenance', 'Repairs']],
  ['utilities', 'Utilities', 'expense', ['Electricity', 'Water', 'Gas', 'Refuse', 'Internet', 'Mobile Phones']],
  ['groceries', 'Groceries', 'expense', ['Supermarkets', 'Household Supplies', 'Toiletries']],
  ['transport', 'Transport', 'expense', ['Fuel', 'Vehicle Maintenance', 'Tyres', 'Tolls', 'Parking', 'Public Transport']],
  ['insurance', 'Insurance', 'expense', ['Vehicle Insurance', 'Home Insurance', 'Life Insurance', 'Other Insurance']],
  ['medical', 'Medical', 'expense', ['Medical Aid', 'Doctor', 'Dentist', 'Medication', 'Pharmacy']],
  ['education', 'Education', 'expense', ['School Fees', 'Stationery', 'Uniforms', 'Extracurricular Activities']],
  ['family', 'Family', 'expense', ['Childcare', 'Clothing', 'Personal Care', 'Pets']],
  ['entertainment', 'Food & Entertainment', 'expense', ['Restaurants', 'Takeaways', 'Coffee', 'Entertainment', 'Streaming']],
  ['shopping', 'Shopping', 'expense', ['Electronics', 'Home Goods', 'Clothing', 'Other Purchases']],
  ['debt', 'Debt', 'expense', ['Personal Loans', 'Credit Card Interest', 'Other Debt Payments']],
  ['savings', 'Savings & Investments', 'savings', ['Emergency Fund', 'Retirement', 'Investments', 'Holiday Savings']],
  ['fees', 'Banking & Fees', 'expense', ['Account Fees', 'Transaction Charges', 'Interest Charges']],
  ['giving', 'Giving', 'expense', ['Gifts', 'Donations']],
  ['misc', 'Miscellaneous', 'expense', ['Unplanned Expenses', 'Other']],
  ['transfers', 'Transfers', 'transfer', ['Between Own Accounts', 'Credit Card Settlement', 'Internal Transfers']],
] as const;

export const defaultRules = [
  ['checkers', 'CHECKERS', 'groceries.0'],
  ['picknpay', 'PICK N PAY', 'groceries.0'],
  ['woolworths', 'WOOLWORTHS', 'groceries.0'],
  ['engen', 'ENGEN', 'transport.0'],
  ['shell', 'SHELL', 'transport.0'],
  ['sasol', 'SASOL', 'transport.0'],
  ['netflix', 'NETFLIX', 'entertainment.4'],
  ['spotify', 'SPOTIFY', 'entertainment.4'],
] as const;

export function defaultGroup(kind: string, name: string) {
  const group = householdTemplate.find(([, , type, children]) =>
    type === kind && children.some((child) => child.toLowerCase() === name.toLowerCase()));
  return group?.[1] ?? ({ expense: 'Miscellaneous', income: 'Income', transfer: 'Transfers', savings: 'Savings & Investments' }[kind] ?? 'Other');
}
