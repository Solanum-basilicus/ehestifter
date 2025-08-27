import azure.functions as func
from routes import register_all


app = func.FunctionApp()

# Register all routes from the routes/ package
register_all(app)
