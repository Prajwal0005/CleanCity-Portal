from pymongo import MongoClient
from config import MONGO_URI

client = MongoClient(MONGO_URI)
db = client["cleancity"]

complaints_collection = db["complaints"]

users_collection = db["users"]
subscriptions_collection = db["subscriptions"]
