import numpy as np
import pandas as pd
from sklearn.neighbors import NearestNeighbors
import sklearn
import matplotlib.pyplot as plt
import seaborn as sns
import warnings
warnings.simplefilter(action='ignore', category=FutureWarning)

# Import necessary modules

#from sklearn.neighbors import KNeighborsClassifier
#from sklearn.model_selection import train_test_split
#from sklearn.datasets import load_iris


# Import user rating data
ratings = pd.read_csv('/Users/geraldyeung/Library/Mobile Documents/com~apple~CloudDocs/stuff/Cards/Sports Cards App/fake ratings data.csv')
# Remove rows with missing values
ratings.dropna(inplace=True)
#print(ratings.head())

# loading card dataset

cards = pd.read_csv('/Users/geraldyeung/Library/Mobile Documents/com~apple~CloudDocs/stuff/Cards/Sports Cards App/SCI 500 card data.csv')

# Remove rows with missing values
#cards.dropna(inplace=True)
#print(cards.head())

# Statistical Analysis of ratings
n_ratings = len(ratings)
n_cards = len(ratings['cardId'].unique())
n_users = len(ratings['userId'].unique())

print(f"Number of ratings: {n_ratings}")
print(f"Number of unique cardId's: {n_cards}")
print(f"Number of unique users: {n_users}")
print(f"Average ratings per user: {round(n_ratings / n_users, 2)}")
print(f"Average ratings per card: {round(n_ratings / n_cards, 2)}")

# User ratings frequency
user_freq = ratings[['userId', 'cardId']].groupby('userId').count().reset_index()
user_freq.columns = ['userId', 'n_ratings']
#print(user_freq.head())

# Card ratings analysis

# Find Lowest and Highest rated cards:
mean_rating = ratings.groupby('cardId')[['rating']].mean()

# Lowest rated card
lowest_rated = mean_rating['rating'].idxmin()
cards.loc[cards['cardId'] == lowest_rated]

# Highest rated cards
highest_rated = mean_rating['rating'].idxmax()
cards.loc[cards['cardId'] == highest_rated]

# show number of people who rated cards rated card highest
ratings[ratings['cardId'] == highest_rated]
# show number of people who rated cards rated card lowest
ratings[ratings['cardId'] == lowest_rated]

## the above cards has very low dataset. We will use bayesian average
card_stats = ratings.groupby('cardId')[['rating']].agg(['count', 'mean'])
card_stats.columns = card_stats.columns.droplevel()

# Now, we create user-item matrix using scipy csr matrix
from scipy.sparse import csr_matrix

def create_matrix(df):
    N = len(df['userId'].unique())
    M = len(df['cardId'].unique())

    # Map Ids to indices
    user_mapper = dict(zip(np.unique(df["userId"]), list(range(N))))
    card_mapper = dict(zip(np.unique(df["cardId"]), list(range(M))))

    # Map indices to IDs
    user_inv_mapper = dict(zip(list(range(N)), np.unique(df["userId"])))
    card_inv_mapper = dict(zip(list(range(M)), np.unique(df["cardId"])))

    user_index = [user_mapper[i] for i in df['userId']]
    card_index = [card_mapper[i] for i in df['cardId']]

    X = csr_matrix((df["rating"], (card_index, user_index)), shape=(M, N))
    return X, user_mapper, card_mapper, user_inv_mapper, card_inv_mapper

X, user_mapper, card_mapper, user_inv_mapper, card_inv_mapper = create_matrix(ratings)


#Find similar cards using KNN

def find_similar_cards(card_id, X, k, metric='cosine', show_distance=False):
    neighbour_ids = []

    card_ind = card_mapper[card_id]
    card_vec = X[card_ind]

    k += 1
    kNN = NearestNeighbors(n_neighbors=k, algorithm="brute", metric=metric)
    kNN.fit(X)

    card_vec = card_vec.reshape(1, -1)
    neighbour = kNN.kneighbors(card_vec, return_distance=show_distance)

    for i in range(0, k):
        n = neighbour.item(i)
        neighbour_ids.append(card_inv_mapper[n])
    neighbour_ids.pop(0)
    return neighbour_ids

card_titles = dict(zip(cards['cardId'], cards['cardName']))
card_id = 3

similar_ids = find_similar_cards(card_id, X, k=10)
card_title = card_titles[card_id]

print("---------------------------------")
print(" ")
print("Since you liked", card_title, " ...")
print("You may also like:")
print(" ")

k = 1

for i in similar_ids:
    print(k,":" ,card_titles[i])
    k = k+1